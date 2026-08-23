mod agent;
mod auth;
mod events;
mod notification;
mod platform;
mod popover;
mod sync;
mod tray;

use agent::{CodingToolBackend, CodingToolRegistry};
use events::DesktopEvent;
use muda::MenuEvent;
use popover::PopoverPanel;
use std::sync::Arc;
use sync::SyncService;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tracing::info;
use tray::TrayManager;
use tray_icon::{MouseButton, TrayIconEvent};

fn main() {
    // Initialize logging output.
    tracing_subscriber::fmt::init();
    info!("Starting Yomi Desktop (Plan B - AI-First Communication Workspace)...");

    // Create the Tokio asynchronous runtime.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio runtime");

    let sync_service = Arc::new(SyncService::new());
    let coding_backend = Arc::new(CodingToolBackend::new(CodingToolRegistry::detect()));

    // Start the background daemon.
    let sync_daemon = sync_service.clone();
    rt.spawn(async move {
        sync_daemon.start_background_daemon();
    });

    // Create the desktop GUI event loop.
    let event_loop = EventLoopBuilder::<DesktopEvent>::with_user_event().build();
    let event_proxy = event_loop.create_proxy();

    // Initialize the Tailscale-style floating popover panel.
    let popover_panel = PopoverPanel::new(
        &event_loop,
        sync_service.clone(),
        coding_backend,
        rt.handle().clone(),
        event_proxy,
    );

    // Initialize the system tray.
    let tray_manager = TrayManager::new(sync_service.clone());
    let menu_channel = MenuEvent::receiver();
    let tray_channel = TrayIconEvent::receiver();

    info!("Yomi Desktop initialized in system tray with Popover panel");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(150),
        );

        match event {
            Event::UserEvent(event) => {
                popover_panel.handle_event(event);
            }
            // Close the popover automatically when it loses focus.
            Event::WindowEvent {
                event: WindowEvent::Focused(false),
                window_id,
                ..
            } if window_id == popover_panel.window.id() => {
                popover_panel.hide();
            }

            Event::NewEvents(_) => {
                // 1. Handle a primary click on the tray icon by showing the popover.
                while let Ok(tray_event) = tray_channel.try_recv() {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: tray_icon::MouseButtonState::Up,
                        ..
                    } = tray_event
                    {
                        popover_panel.toggle();
                    }
                }

                // 2. Handle context-menu actions.
                while let Ok(menu_event) = menu_channel.try_recv() {
                    match menu_event.id.as_ref() {
                        "sync" => {
                            tray_manager.sync_service.trigger_manual_sync();
                            tray_manager.refresh_status();
                            popover_panel.refresh_data();
                        }
                        "test_notify" => {
                            tray_manager.sync_service.send_test_notification();
                        }
                        "open_doc" => {
                            info!("Opening Yomi documentation...");
                            let _ = platform::open_url(
                                "https://rikaidev.github.io/yomi/zh-tw/line-mcp/",
                            );
                        }
                        "quit" => {
                            info!("Exiting Yomi Desktop");
                            *control_flow = ControlFlow::Exit;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    });
}
