#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod services;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Show,
    ToggleWindow,
    Voice,
    Stop,
}

fn shortcuts() -> [(Shortcut, Action); 3] {
    let primary = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    let modifiers = Some(primary | Modifiers::SHIFT);
    [
        (Shortcut::new(modifiers, Code::KeyJ), Action::ToggleWindow),
        (Shortcut::new(modifiers, Code::Space), Action::Voice),
        (Shortcut::new(modifiers, Code::Escape), Action::Stop),
    ]
}

#[cfg(windows)]
fn windows_stop_fallback() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::Escape,
    )
}

fn dispatch(app: &AppHandle, action: Action) {
    if action == Action::Stop {
        let endpoint = app.state::<services::Services>().endpoint().clone();
        tauri::async_runtime::spawn_blocking(move || match endpoint.stop() {
            Ok(()) => eprintln!("Jarvis3: Not-Aus bestätigt (POST /stop)"),
            Err(error) => eprintln!("Jarvis3: Not-Aus fehlgeschlagen: {error}"),
        });
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = handle_window(&window, action) {
            eprintln!("Jarvis3: Fensteraktion {action:?}: {error}");
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
                    #[cfg(windows)]
                    if *shortcut == windows_stop_fallback() {
                        dispatch(app, Action::Stop);
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
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_tray(app.handle())?;
            for (shortcut, action) in shortcuts() {
                match app.global_shortcut().register(shortcut) {
                    Ok(()) => eprintln!("Jarvis3: globaler Hotkey registriert: {action:?}"),
                    Err(error) => {
                        eprintln!("Jarvis3: globaler Hotkey {action:?} nicht verfügbar: {error}")
                    }
                }
            }
            #[cfg(windows)]
            match app.global_shortcut().register(windows_stop_fallback()) {
                Ok(()) => eprintln!(
                    "Jarvis3: Windows-Not-Aus zusätzlich auf Ctrl+Alt+Shift+Escape registriert"
                ),
                Err(error) => {
                    eprintln!("Jarvis3: Windows-Ersatzhotkey für Not-Aus nicht verfügbar: {error}")
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
        let expected = [
            (Code::KeyJ, Action::ToggleWindow),
            (Code::Space, Action::Voice),
            (Code::Escape, Action::Stop),
        ];
        let modifier = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        for ((key, action), (expected_key, expected_action)) in mapping.into_iter().zip(expected) {
            assert_eq!(action, expected_action);
            assert_eq!(
                key,
                Shortcut::new(Some(modifier | Modifiers::SHIFT), expected_key)
            );
        }
        assert_ne!(mapping[0].0.id(), mapping[1].0.id());
        assert_ne!(mapping[0].0.id(), mapping[2].0.id());
        assert_ne!(mapping[1].0.id(), mapping[2].0.id());
    }
}
