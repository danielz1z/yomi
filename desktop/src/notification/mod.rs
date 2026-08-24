use notify_rust::Notification;
use tracing::{info, warn};

pub struct NotificationService;

impl NotificationService {
    /// Send a native desktop notification.
    pub fn show(title: &str, body: &str) {
        info!("發送桌面通知: [{}] {}", title, body);

        let res = Notification::new()
            .appname("Yomi Desktop")
            .id(1)
            .summary(title)
            .body(body)
            .show();

        if let Err(e) = res {
            warn!("notify-rust 發送通知失敗: {:?}", e);

            #[cfg(target_os = "macos")]
            {
                let script = format!(
                    "display notification \"{}\" with title \"{}\" sound name \"default\"",
                    body.replace('\\', "\\\\").replace('\"', "\\\""),
                    title.replace('\\', "\\\\").replace('\"', "\\\"")
                );
                let _ = std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(script)
                    .output();
            }
        }
    }
}
