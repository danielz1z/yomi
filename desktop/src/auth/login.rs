use crate::events::{DesktopEvent, LoginUiState};
use crate::platform::yomi_runtime_paths;
use serde::Deserialize;
use std::process::Stdio;
use tao::event_loop::EventLoopProxy;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    phone: String,
    region: String,
}

impl LoginRequest {
    fn normalized(self) -> Result<Self, String> {
        let region = self.region.trim().to_uppercase();
        if !["TW", "JP", "TH", "ID", "US"].contains(&region.as_str()) {
            return Err("Choose a supported LINE region.".to_string());
        }
        let mut phone: String = self
            .phone
            .chars()
            .filter(|character| !character.is_whitespace() && *character != '-')
            .collect();
        if region == "TW" && phone.starts_with("09") {
            phone = format!("+886{}", &phone[1..]);
        }
        let digits = phone.strip_prefix('+').unwrap_or(&phone);
        if !phone.starts_with('+')
            || !(8..=18).contains(&digits.len())
            || !digits.chars().all(|character| character.is_ascii_digit())
        {
            return Err("Enter a phone number in international format, such as +8869…".to_string());
        }
        Ok(Self { phone, region })
    }
}

pub async fn run_login(request: LoginRequest, proxy: EventLoopProxy<DesktopEvent>) {
    let request = match request.normalized() {
        Ok(request) => request,
        Err(message) => {
            let _ = proxy.send_event(DesktopEvent::Login(LoginUiState::Error { message }));
            return;
        }
    };
    let _ = proxy.send_event(DesktopEvent::Login(LoginUiState::Starting));
    let (node, run_mjs, cwd) = match yomi_runtime_paths() {
        Some(paths) => paths,
        None => {
            let _ = proxy.send_event(DesktopEvent::Login(LoginUiState::Error {
                message: "The bundled Yomi login runtime is missing. Reinstall Yomi Desktop."
                    .to_string(),
            }));
            return;
        }
    };

    let mut child = match Command::new(node)
        .arg(run_mjs)
        .args([
            "login",
            "--phone",
            &request.phone,
            "--region",
            &request.region,
        ])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = proxy.send_event(DesktopEvent::Login(LoginUiState::Error {
                message: format!("Could not start Yomi login: {error}"),
            }));
            return;
        }
    };

    let (sender, mut receiver) = mpsc::unbounded_channel();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(forward_lines(stdout, sender.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(forward_lines(stderr, sender.clone()));
    }
    drop(sender);

    let mut succeeded = false;
    let mut safe_failure = None;
    while let Some(line) = receiver.recv().await {
        if let Some(state) = parse_login_line(&line) {
            if matches!(state, LoginUiState::Success) {
                succeeded = true;
            }
            if let LoginUiState::Error { message } = &state {
                safe_failure = Some(message.clone());
            }
            let _ = proxy.send_event(DesktopEvent::Login(state));
        }
    }

    match child.wait().await {
        Ok(status) if status.success() && succeeded => {
            let _ = proxy.send_event(DesktopEvent::RefreshAccount);
        }
        Ok(_) | Err(_) if !succeeded => {
            let _ = proxy.send_event(DesktopEvent::Login(LoginUiState::Error {
                message: safe_failure.unwrap_or_else(|| {
                    "LINE login did not complete. Check the phone confirmation and try again."
                        .to_string()
                }),
            }));
        }
        _ => {}
    }
}

async fn forward_lines<R>(reader: R, sender: mpsc::UnboundedSender<String>)
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = sender.send(line);
    }
}

fn parse_login_line(line: &str) -> Option<LoginUiState> {
    let trimmed = line.trim();
    if let Some((_, value)) = trimmed.split_once("PIN:") {
        let pin: String = value.chars().filter(char::is_ascii_digit).take(8).collect();
        if (4..=8).contains(&pin.len()) {
            return Some(LoginUiState::Pin { pin });
        }
    }
    if trimmed.contains("Waiting for you to approve") {
        return Some(LoginUiState::WaitingApproval { pin: String::new() });
    }
    if trimmed.contains("Login successful") {
        return Some(LoginUiState::Success);
    }
    if let Some((_, message)) = trimmed.split_once("Login failed:") {
        return Some(LoginUiState::Error {
            message: message.trim().to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{parse_login_line, LoginRequest};
    use crate::events::LoginUiState;

    #[test]
    fn normalizes_taiwan_phone_without_accepting_shell_text() {
        let request = LoginRequest {
            phone: "0912-345-678".to_string(),
            region: "tw".to_string(),
        }
        .normalized()
        .unwrap();
        assert_eq!(request.phone, "+886912345678");
        assert_eq!(request.region, "TW");
        assert!(LoginRequest {
            phone: "+8869; calc".to_string(),
            region: "TW".to_string(),
        }
        .normalized()
        .is_err());
    }

    #[test]
    fn parses_only_safe_login_status_from_process_output() {
        assert!(matches!(
            parse_login_line("[Yomi] PIN: 123456"),
            Some(LoginUiState::Pin { pin }) if pin == "123456"
        ));
        assert!(matches!(
            parse_login_line("[Yomi] Login successful: mid=u123"),
            Some(LoginUiState::Success)
        ));
        assert!(parse_login_line("phone=+886912345678").is_none());
    }
}
