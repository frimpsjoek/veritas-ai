//! Veritas desktop app (spec 024 G3): a window on the Veritas web app, served by the bundled server on this computer.
//!
//! Start: the window shows a bundled start page (ui/index.html), which calls `boot`: the web app is copied into the
//! data folder, the search model is downloaded the first time, the server starts, and the window moves to
//! http://127.0.0.1:<port>/app/, where the web app's own guided setup (spec 023) takes over.
// no console window next to the app on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod server;
mod web;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Passed by the login item, so a start at login waits in the menu bar instead of opening a window.
const HIDDEN: &str = "--hidden";

#[derive(Default)]
struct Running(Mutex<Option<server::Server>>);

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("no app-data folder: {e}"))
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn stop_server(app: &AppHandle) {
    if let Some(mut running) = app.state::<Running>().0.lock().ok().and_then(|mut s| s.take()) {
        running.stop();
    }
}

fn quit(app: &AppHandle) {
    let _ = app.save_window_state(StateFlags::all());
    stop_server(app);
    app.exit(0);
}

/// Called by the start page once it listens for progress. Returns the error to show (with a Retry button) if a
/// step fails. On a first start with an index elsewhere on this computer it returns `{"offer": [...]}` first, and
/// the page calls again with `reuse`: a folder to copy the index from, or "fresh" to build a new one. Otherwise
/// it returns `{"started": url}` with the window already on the web app.
#[tauri::command]
async fn boot(app: AppHandle, reuse: Option<String>) -> Result<serde_json::Value, String> {
    let data = data_dir(&app)?;
    std::fs::create_dir_all(&data).map_err(|e| format!("cannot create {}: {e}", data.display()))?;
    server::look_at_source_folders(&data);
    let bundled = app.path().resource_dir().map_err(|e| e.to_string())?.join("web");
    web::install(&bundled, &data)?;
    if server::first_start(&data) {
        // Re-embedding a library takes hours and the search model; an index this computer already has is copied
        // in seconds, and the server's incremental index then reads only what changed.
        let folder = data.clone();
        match reuse.as_deref() {
            None => {
                let found = tauri::async_runtime::spawn_blocking(move || server::find_indexes(&folder))
                    .await
                    .map_err(|e| e.to_string())?;
                if !found.is_empty() {
                    return Ok(serde_json::json!({ "offer": found }));
                }
            }
            Some("fresh") => {}
            Some(from) => {
                let from = from.to_string();
                tauri::async_runtime::spawn_blocking(move || server::import_index(&folder, &from))
                    .await
                    .map_err(|e| e.to_string())??;
            }
        }
    }
    if !model::present(&data) {
        model::download(&app, &data).await?;
    }
    // started on a blocking thread, which may hold the lock while the server comes up (a Retry waits for it)
    let handle = app.clone();
    let url = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let running = handle.state::<Running>();
        let mut slot = running.0.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            *slot = Some(server::Server::start(&data)?);
        }
        Ok(slot.as_ref().map(|s| s.url()).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())??;
    let window = main_window(&app).ok_or("the window is gone")?;
    window.navigate(Url::parse(&url).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { offer_update(handle).await });
    Ok(serde_json::json!({ "started": url }))
}

/// "Choose a folder…" on the start page: another install's data folder to copy the index from.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("The Veritas data folder to use (it holds kb.sqlite)").blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .map(|folder| folder.to_string())
}

/// Checks GitHub Releases once per start; installs only when the user says so (spec 024 G3, G4).
async fn offer_update(app: AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return }; // offline or no release: nothing to say
    let message = format!(
        "Veritas {} is available (you have {}). Install it now? Veritas restarts; your library and settings stay.",
        update.version, update.current_version
    );
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Update Veritas")
        .buttons(MessageDialogButtons::OkCancelCustom("Install and restart".into(), "Later".into()))
        .show(move |install| {
            if !install {
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        stop_server(&handle);
                        handle.restart();
                    }
                    Err(error) => {
                        handle.dialog().message(format!("The update could not be installed: {error}")).title("Update Veritas").show(|_| {});
                    }
                }
            });
        });
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Veritas", true, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Start at login", true, at_login, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Veritas", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &login, &PredefinedMenuItem::separator(app)?, &quit_item])?;
    let login_item = login.clone();
    TrayIconBuilder::with_id("veritas")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .tooltip("Veritas")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show(app),
            "login" => {
                let launcher = app.autolaunch();
                let on = launcher.is_enabled().unwrap_or(false);
                let _ = if on { launcher.disable() } else { launcher.enable() };
                let _ = login_item.set_checked(launcher.is_enabled().unwrap_or(!on));
            }
            "quit" => quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // first, so a second launch only brings this window forward instead of starting a second server
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN])))
        // visibility is the app's call (hidden at login, shown otherwise), not a remembered state
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(StateFlags::all() - StateFlags::VISIBLE).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![boot, pick_folder])
        .setup(|app| {
            tray(app.handle())?;
            if !std::env::args().any(|a| a == HIDDEN) {
                show(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Veritas running in the menu bar / tray, for the plugins and the phone;
            // Quit in the tray menu stops it.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.app_handle().save_window_state(StateFlags::all());
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("Veritas could not start");
    app.run(|app, event| match event {
        RunEvent::Exit => stop_server(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
