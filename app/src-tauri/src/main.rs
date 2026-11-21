#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod errorlog;
mod services;

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// Manche Windows-Tastaturtreiber liefern für eine Betätigung zwei Pressed-Ereignisse.
static LAST_DISPATCH: Mutex<Option<(Action, Instant)>> = Mutex::new(None);
const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Show,
    ToggleWindow,
    Voice,
    Stop,
}

fn shortcuts() -> Vec<(Shortcut, Action)> {
    let primary = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    let modifiers = Some(primary | Modifiers::SHIFT);
    let mut keys = vec![
        (Shortcut::new(modifiers, Code::KeyJ), Action::ToggleWindow),
        (Shortcut::new(modifiers, Code::Space), Action::Voice),
    ];
    // Windows reserviert Ctrl+Shift+Escape für den Task-Manager; dort gilt der Ersatzhotkey.
    #[cfg(windows)]
    keys.push((windows_stop_fallback(), Action::Stop));
    #[cfg(not(windows))]
    keys.push((Shortcut::new(modifiers, Code::Escape), Action::Stop));
    keys
}

#[cfg(windows)]
fn windows_stop_fallback() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::Escape,
    )
}

fn dispatch(app: &AppHandle, action: Action) {
    {
        let mut last = LAST_DISPATCH.lock().unwrap();
        let now = Instant::now();
        if let Some((previous, at)) = *last {
            if previous == action && now.duration_since(at) < DEBOUNCE {
                eprintln!("Jarvis3: doppeltes Hotkey-Ereignis {action:?} ignoriert");
                return;
            }
        }
        *last = Some((action, now));
    }
    eprintln!("Jarvis3: Hotkey {action:?} ausgelöst");
    if action == Action::Stop {
        let endpoint = app.state::<services::Services>().endpoint().clone();
        tauri::async_runtime::spawn_blocking(move || match endpoint.stop() {
            Ok(()) => eprintln!("Jarvis3: Not-Aus bestätigt (POST /stop)"),
            Err(error) => {
                eprintln!("Jarvis3: Not-Aus fehlgeschlagen: {error}");
                errorlog::record("app", "tauri/stop", &format!("Not-Aus fehlgeschlagen: {error}"), serde_json::json!({ "hotkey": "stop" }));
            }
        });
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = handle_window(&window, action) {
            eprintln!("Jarvis3: Fensteraktion {action:?}: {error}");
            errorlog::record("app", "tauri/window", &format!("Fensteraktion fehlgeschlagen: {error}"), serde_json::json!({ "action": format!("{action:?}") }));
        }
    }
}

fn handle_window(window: &WebviewWindow, action: Action) -> tauri::Result<()> {
    if action == Action::ToggleWindow && window.is_visible()? && !window.is_minimized()? {
        return window.hide();
    }
    window.show()?;
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.set_focus()?;
    let event = match action {
        Action::Voice => "jarvis:voice",
        _ => "jarvis:focus",
    };
    window.emit_to(window.label(), event, ())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Öffnen", true, None::<&str>)?;
    let voice = MenuItem::with_id(app, "voice", "Sprachmodus", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Not-Aus", true, None::<&str>)?;
    let enabled = app.autolaunch().is_enabled();
    if let Err(error) = &enabled {
        eprintln!("Jarvis3: Autostart-Status nicht verfügbar: {error}");
    }
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Beim Anmelden starten",
        enabled.is_ok(),
        enabled.unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &voice, &stop, &autostart, &quit])?;

    TrayIconBuilder::with_id("jarvis3")
        .icon(Image::new(
            include_bytes!(concat!(env!("OUT_DIR"), "/tray.rgba")),
            36,
            36,
        ))
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Jarvis3")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => dispatch(app, Action::Show),
            "voice" => dispatch(app, Action::Voice),
            "stop" => dispatch(app, Action::Stop),
            "autostart" => {
                let result = if autostart.is_checked().unwrap_or(false) {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                if let Err(error) = result {
                    eprintln!("Jarvis3: Autostart konnte nicht geändert werden: {error}");
                }
                if let Ok(enabled) = app.autolaunch().is_enabled() {
                    let _ = autostart.set_checked(enabled);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() -> tauri::Result<()> {
    errorlog::install_panic_hook();
    let background = std::env::args_os().any(|arg| arg == "--background");
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some((_, action)) =
                        shortcuts().into_iter().find(|(key, _)| key == shortcut)
                    {
                        dispatch(app, action);
                    }
                })
                .build(),
        )
        .manage(services::Services::new())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if background {
                tauri::ActivationPolicy::Accessory
            } else {
                tauri::ActivationPolicy::Regular
            });
            setup_tray(app.handle())?;
            for (shortcut, action) in shortcuts() {
                match app.global_shortcut().register(shortcut) {
                    Ok(()) => eprintln!("Jarvis3: globaler Hotkey registriert: {action:?}"),
                    Err(error) => {
                        errorlog::record("app", "tauri/hotkey", &format!("Globaler Hotkey nicht verfügbar: {error}"), serde_json::json!({ "action": format!("{action:?}")}));
                        eprintln!("Jarvis3: globaler Hotkey {action:?} nicht verfügbar: {error}")
                    }
                }
            }
            if !background {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                }
            }
            let handle = app.handle().clone();
            if let Err(error) = ctrlc::set_handler(move || handle.exit(0)) {
                eprintln!("Jarvis3: Signal-Handler konnte nicht registriert werden: {error}");
            }
            app.state::<services::Services>().start();
            eprintln!("Jarvis3: Desktop-Hülle bereit");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // Live-Modus aktiv beenden: UI sendet damit "voice: off" an jarvisd,
                    // bevor die Webview in den Hintergrund geht.
                    let script = "(()=>{const live=document.getElementById('live'); \
                                  if(live && !live.hidden) document.getElementById('liveEnd')?.click();})()";
                    if let Some(webview) = window.webviews().first() {
                        if let Err(error) = webview.eval(script) {
                            eprintln!("Jarvis3: Sprachmodus beim Schließen nicht beendet: {error}");
                        }
                    }
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())?;

    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<services::Services>().shutdown();
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_have_distinct_ids_and_match_contract() {
        let mapping = shortcuts();
        assert_eq!(mapping.len(), 3);
        let modifier = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        assert_eq!(
            mapping[0],
            (
                Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::KeyJ),
                Action::ToggleWindow
            )
        );
        assert_eq!(
            mapping[1],
            (
                Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::Space),
                Action::Voice
            )
        );
        #[cfg(windows)]
        assert_eq!(mapping[2], (windows_stop_fallback(), Action::Stop));
        #[cfg(not(windows))]
        assert_eq!(
            mapping[2],
            (
                Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::Escape),
                Action::Stop
            )
        );
        assert_ne!(mapping[0].0.id(), mapping[1].0.id());
        assert_ne!(mapping[0].0.id(), mapping[2].0.id());
        assert_ne!(mapping[1].0.id(), mapping[2].0.id());
    }
}
