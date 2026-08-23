use crate::auth::keychain::KeychainStore;
use crate::notification::NotificationService;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::time::{sleep, Duration};
use tracing::{info, warn};

#[derive(Clone)]
pub struct SyncService {
    running: Arc<AtomicBool>,
    is_connected: Arc<AtomicBool>,
    latest_mid: Arc<RwLock<Option<String>>>,
}

impl Default for SyncService {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            is_connected: Arc::new(AtomicBool::new(false)),
            latest_mid: Arc::new(RwLock::new(None)),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.is_connected.load(Ordering::SeqCst)
    }

    pub fn get_mid(&self) -> Option<String> {
        self.latest_mid.read().unwrap().clone()
    }

    /// Start the fallback background LINE sync polling daemon.
    pub fn start_background_daemon(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_conn = self.is_connected.clone();
        let mid_store = self.latest_mid.clone();

        tokio::spawn(async move {
            info!("Yomi Desktop background daemon active. Monitoring shared keychain session...");

            loop {
                match KeychainStore::load() {
                    Ok(creds) => {
                        if creds.is_valid() {
                            let was_connected = is_conn.swap(true, Ordering::SeqCst);
                            let current_mid = creds.line_mid.clone();
                            if let Ok(mut lock) = mid_store.write() {
                                *lock = current_mid.clone();
                            }

                            if !was_connected {
                                let mid_disp = current_mid.as_deref().unwrap_or("User");
                                info!("Yomi Desktop authenticated with MID: {}", mid_disp);
                                NotificationService::show(
                                    "Yomi Desktop Connected",
                                    &format!(
                                        "LINE session loaded (MID: {}). Shared MCP ready.",
                                        mid_disp
                                    ),
                                );
                            }
                        } else {
                            if is_conn.swap(false, Ordering::SeqCst) {
                                warn!("LINE session invalid or expired");
                            }
                            if let Ok(mut lock) = mid_store.write() {
                                *lock = None;
                            }
                        }
                    }
                    Err(_) => {
                        if is_conn.swap(false, Ordering::SeqCst) {
                            warn!("No valid credentials in keychain");
                        }
                        if let Ok(mut lock) = mid_store.write() {
                            *lock = None;
                        }
                    }
                }

                // Check credentials and sync state every 15 seconds.
                sleep(Duration::from_secs(15)).await;
            }
        });
    }

    /// Trigger an immediate sync check manually.
    pub fn trigger_manual_sync(&self) {
        info!("Manual sync triggered...");
        match KeychainStore::load() {
            Ok(creds) if creds.is_valid() => {
                let mid = creds.mid_display();
                NotificationService::show(
                    "Yomi Sync Active",
                    &format!(
                        "LINE connection healthy (MID: {}). Shared credentials synchronized.",
                        mid
                    ),
                );
            }
            _ => {
                NotificationService::show(
                    "Yomi Not Authenticated",
                    "No credentials found in system Keychain. Sign in via Claude MCP or `npx @rikaidev/yomi login`.",
                );
            }
        }
    }

    /// Send a test notification.
    pub fn send_test_notification(&self) {
        let status = if self.is_connected() {
            let mid = self.get_mid().unwrap_or_else(|| "User".to_string());
            format!("Connected ({})", mid)
        } else {
            "Awaiting Authentication".to_string()
        };

        NotificationService::show(
            "Yomi Notification Test",
            &format!(
                "Instant desktop notification delivery active.\nSession State: {}",
                status
            ),
        );
    }
}
