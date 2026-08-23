pub mod icon;

use crate::auth::keychain::KeychainStore;
use crate::sync::SyncService;
use icon::create_tray_icon;
use muda::{Menu, MenuItem, PredefinedMenuItem};
use std::sync::Arc;
use tray_icon::{TrayIcon, TrayIconBuilder};

pub struct TrayManager {
    pub tray_icon: TrayIcon,
    pub status_item: MenuItem,
    #[allow(dead_code)]
    pub sync_item: MenuItem,
    #[allow(dead_code)]
    pub test_notify_item: MenuItem,
    #[allow(dead_code)]
    pub open_doc_item: MenuItem,
    #[allow(dead_code)]
    pub quit_item: MenuItem,
    pub sync_service: Arc<SyncService>,
}

impl TrayManager {
    pub fn new(sync_service: Arc<SyncService>) -> Self {
        let menu = Menu::new();

        // Read the initial state.
        let (initial_text, is_conn) = match KeychainStore::load() {
            Ok(creds) if creds.is_valid() => {
                let mid = creds.mid_display();
                (format!("Connected · {}", mid), true)
            }
            _ => (
                "Not Logged In · Please Authenticate via MCP".to_string(),
                false,
            ),
        };

        let status_item = MenuItem::with_id("status", &initial_text, false, None);
        let sync_item = MenuItem::with_id("sync", "Sync Messages Now", true, None);
        let test_notify_item =
            MenuItem::with_id("test_notify", "Send Test Notification", true, None);
        let open_doc_item = MenuItem::with_id("open_doc", "Documentation & Guide", true, None);
        let quit_item = MenuItem::with_id("quit", "Quit Yomi Desktop", true, None);

        menu.append(&status_item).unwrap();
        menu.append(&PredefinedMenuItem::separator()).unwrap();
        menu.append(&sync_item).unwrap();
        menu.append(&test_notify_item).unwrap();
        menu.append(&open_doc_item).unwrap();
        menu.append(&PredefinedMenuItem::separator()).unwrap();
        menu.append(&quit_item).unwrap();

        let icon = create_tray_icon(is_conn, false);

        let tray_icon = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false) // Left click triggers popover window! Right click opens menu
            .with_tooltip("Yomi — AI-first Personal Communication Workspace")
            .with_icon(icon)
            .build()
            .expect("Failed to initialize system tray icon");

        Self {
            tray_icon,
            status_item,
            sync_item,
            test_notify_item,
            open_doc_item,
            quit_item,
            sync_service,
        }
    }

    /// Update tray status text and icon color.
    pub fn refresh_status(&self) {
        let (status_text, is_conn) = match KeychainStore::load() {
            Ok(creds) if creds.is_valid() => {
                let mid = creds.mid_display();
                (format!("Connected · {}", mid), true)
            }
            _ => (
                "Not Logged In · Please Authenticate via MCP".to_string(),
                false,
            ),
        };

        self.status_item.set_text(status_text);
        let icon = create_tray_icon(is_conn, false);
        let _ = self.tray_icon.set_icon(Some(icon));
    }
}
