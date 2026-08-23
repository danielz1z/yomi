use crate::agent::CodingToolBackend;
use crate::auth::keychain::KeychainStore;
use crate::auth::login::{run_login, LoginRequest};
use crate::events::DesktopEvent;
use crate::notification::NotificationService;
use crate::platform::open_url;
use crate::sync::SyncService;
use serde_json::{json, Value};
use std::sync::Arc;
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder};
use tokio::runtime::Handle;
use tracing::info;
use wry::{WebView, WebViewBuilder};

pub const POPOVER_HTML: &str = include_str!("view.html");

pub struct PopoverPanel {
    pub window: Window,
    pub webview: WebView,
    pub coding_backend: Arc<CodingToolBackend>,
    #[allow(dead_code)]
    pub sync_service: Arc<SyncService>,
}

impl PopoverPanel {
    pub fn new(
        window_target: &EventLoopWindowTarget<DesktopEvent>,
        sync_service: Arc<SyncService>,
        coding_backend: Arc<CodingToolBackend>,
        runtime_handle: Handle,
        event_proxy: EventLoopProxy<DesktopEvent>,
    ) -> Self {
        let width = 340.0;
        let height = 500.0;

        let window = WindowBuilder::new()
            .with_title("Yomi")
            .with_inner_size(LogicalSize::new(width, height))
            .with_decorations(false)
            .with_transparent(true)
            .with_always_on_top(true)
            .with_resizable(false)
            .with_visible(false)
            .build(window_target)
            .expect("Failed to build popover window");

        let sync_clone = sync_service.clone();
        let coding_backend_for_ipc = coding_backend.clone();
        let runtime_handle_for_ipc = runtime_handle.clone();
        let event_proxy_for_ipc = event_proxy.clone();

        let webview = WebViewBuilder::new()
            .with_html(POPOVER_HTML)
            .with_transparent(true)
            .with_ipc_handler(move |msg| {
                let action = msg.body();
                info!("Popover action triggered: {}", action_name(action));
                match action.as_str() {
                    "sync" => {
                        sync_clone.trigger_manual_sync();
                    }
                    "test_notify" => {
                        sync_clone.send_test_notification();
                    }
                    "open_doc" => {
                        let _ = open_url("https://rikaidev.github.io/yomi/zh-tw/line-mcp/");
                    }
                    "open_workspace" => {
                        let _ = open_url("https://rikaidev.github.io/yomi/");
                    }
                    "settings" => {
                        info!("Open Settings dialog");
                        sync_clone.trigger_manual_sync();
                    }
                    action if action.starts_with("coding_tool_run:") => {
                        let payload = &action["coding_tool_run:".len()..];
                        if let Ok(request) = serde_json::from_str::<CodingToolRequest>(payload) {
                            let backend = coding_backend_for_ipc.clone();
                            let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
                            runtime_handle_for_ipc.spawn(async move {
                                match backend
                                    .run(Some(request.provider.as_str()), &request.prompt, &cwd)
                                    .await
                                {
                                    Ok(output) => NotificationService::show(
                                        "Yomi coding tool completed",
                                        &truncate_notification(&output),
                                    ),
                                    Err(error) => NotificationService::show(
                                        "Yomi coding tool failed",
                                        &truncate_notification(&error),
                                    ),
                                }
                            });
                        }
                    }
                    action if action.starts_with("login_start:") => {
                        let payload = &action["login_start:".len()..];
                        if let Ok(request) = serde_json::from_str::<LoginRequest>(payload) {
                            let proxy = event_proxy_for_ipc.clone();
                            runtime_handle_for_ipc.spawn(run_login(request, proxy));
                        } else {
                            let _ = event_proxy_for_ipc.send_event(DesktopEvent::Login(
                                crate::events::LoginUiState::Error {
                                    message: "The login form was invalid. Check the phone number and try again.".to_string(),
                                },
                            ));
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            })
            .build(&window)
            .expect("Failed to initialize webview for popover");

        let panel = Self {
            window,
            webview,
            sync_service,
            coding_backend,
        };

        panel.refresh_data();
        panel
    }

    pub fn handle_event(&self, event: DesktopEvent) {
        match event {
            DesktopEvent::Login(state) => {
                if let Ok(json) = serde_json::to_string(&state) {
                    let script = format!(
                        "if (window.updateLoginState) {{ window.updateLoginState({json}); }}"
                    );
                    let _ = self.webview.evaluate_script(&script);
                }
            }
            DesktopEvent::RefreshAccount => self.refresh_data(),
        }
    }

    /// Toggle popover panel visibility.
    pub fn toggle(&self) {
        let is_vis = self.window.is_visible();
        if is_vis {
            self.window.set_visible(false);
        } else {
            self.refresh_data();

            // Position the panel below the macOS menu bar at the upper-right corner.
            if let Some(monitor) = self.window.current_monitor() {
                let screen_size = monitor.size();
                let scale = monitor.scale_factor();
                let screen_width = screen_size.width as f64 / scale;
                let target_x = (screen_width - 360.0).max(20.0);
                self.window
                    .set_outer_position(LogicalPosition::new(target_x, 32.0));
            } else {
                self.window
                    .set_outer_position(LogicalPosition::new(1000.0, 32.0));
            }

            self.window.set_visible(true);
            self.window.set_focus();
        }
    }

    /// Hide the popover.
    pub fn hide(&self) {
        if self.window.is_visible() {
            self.window.set_visible(false);
        }
    }

    /// Update account data and connection state in the panel.
    pub fn refresh_data(&self) {
        let (connected, mid, display_name, avatar_text) = match KeychainStore::load() {
            Ok(creds) if creds.is_valid() => {
                let mid_str = creds.mid_display();
                let avatar = if mid_str.len() >= 3 {
                    mid_str[1..3].to_uppercase()
                } else {
                    "YM".to_string()
                };
                (
                    true,
                    mid_str.clone(),
                    format!("LINE User ({})", &mid_str[..mid_str.len().min(8)]),
                    avatar,
                )
            }
            _ => (
                false,
                "".to_string(),
                "Not Logged In".to_string(),
                "YM".to_string(),
            ),
        };

        let state_json = json!({
            "connected": connected,
            "mid": mid,
            "displayName": display_name,
            "avatarText": avatar_text
        })
        .as_object_mut()
        .map(|state| {
            state.extend(
                self.coding_backend
                    .registry()
                    .status_json()
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            );
            Value::Object(state.clone())
        })
        .unwrap_or_else(|| json!({}));

        let script = format!(
            "if (window.updateState) {{ window.updateState({}); }}",
            state_json
        );
        let _ = self.webview.evaluate_script(&script);
    }
}

#[derive(Debug, serde::Deserialize)]
struct CodingToolRequest {
    provider: String,
    prompt: String,
}

fn truncate_notification(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= 180 {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(179).collect::<String>())
}

fn action_name(action: &str) -> &str {
    action.split_once(':').map_or(action, |(name, _)| name)
}
