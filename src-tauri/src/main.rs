#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod commands;

use am_core::AppCore;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// Apps opened from a desktop launcher get a minimal PATH, which hides
/// user-installed CLIs (and the `node` they run on). Adopt the
/// PATH of the user's login shell, bounded by a short timeout.
#[cfg(unix)]
fn inherit_login_shell_path() {
    use std::io::Read;
    use std::time::{Duration, Instant};
    let default_shell = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell.into());
    let Ok(mut child) = std::process::Command::new(shell)
        .args([
            "-ilc",
            r#"printf '__PERPETUAL_PATH__%s__PERPETUAL_PATH__' "$PATH""#,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return,
        }
    }
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
        return;
    }
    let mut out = String::new();
    if child
        .stdout
        .take()
        .map(|mut s| s.read_to_string(&mut out))
        .is_none()
    {
        return;
    }
    let Some(path) = out
        .split("__PERPETUAL_PATH__")
        .nth(1)
        .filter(|p| !p.is_empty())
    else {
        return;
    };
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(path).collect();
    if let Some(current) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&current) {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        // Runs before any other thread exists.
        std::env::set_var("PATH", joined);
    }
}

fn main() {
    #[cfg(unix)]
    inherit_login_shell_path();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::request,
            commands::sign_in,
            commands::data_dir
        ])
        .setup(|app| {
            // Desktop data is isolated from the extension: two schedulers must never own one DB.
            // PERPETUAL_DATA_DIR points a development or test run at a throwaway directory.
            let dir = match std::env::var_os("PERPETUAL_DATA_DIR") {
                Some(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
                _ => app.path().app_data_dir()?,
            };
            let core = tauri::async_runtime::block_on(AppCore::new(&dir))?;
            let mut events = core.events.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit("perpetual-event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = handle.emit("perpetual-refresh", ());
                        }
                        Err(_) => break,
                    }
                }
            });
            let power =
                tauri::async_runtime::block_on(async { am_daemon::power::spawn(core.clone()) });
            app.manage(commands::Engine {
                core,
                power: tokio::sync::Mutex::new(Some(power)),
            });
            app.manage(AtomicBool::new(false));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Perpetual");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let closing = app.state::<AtomicBool>();
            if !closing.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let engine = handle.state::<commands::Engine>();
                    let _ = engine.core.prepare_shutdown().await;
                    if let Some(power) = engine.power.lock().await.take() {
                        power.shutdown().await;
                    }
                    engine.core.shutdown().await;
                    handle.exit(0);
                });
            }
        }
    });
}
