//! Updates from GitHub Releases (spec 033 R3). Checked at start and every 6 hours. With "Install updates automatically"
//! on (the default), a new version is downloaded in the background and installed once Veritas is not in use: no window
//! focused for IDLE (or the window closed to the menu bar that long). Then the app restarts itself and, on the next
//! start, says once which version it was updated to. With the setting off, a found update is offered as before
//! ("Install and restart" / "Later"). The updater checks the release's signature against the key in tauri.conf.json.
//! The setting is `<data dir>/updates.json` {"auto": bool}; the version installed is noted in `<data dir>/updated-to`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// How long Veritas must go unused before an update installs.
pub const IDLE: Duration = Duration::from_secs(15 * 60);
/// How often GitHub is asked for a newer release.
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How often a downloaded update looks for a quiet moment.
const POLL: Duration = Duration::from_secs(60);

/// When a Veritas window was last in use (focused), and whether one is in use now.
#[derive(Default)]
pub struct Activity(Mutex<(Option<Instant>, bool)>);

impl Activity {
    /// A window gained (true) or lost (false) focus.
    pub fn focused(&self, on: bool) {
        if let Ok(mut a) = self.0.lock() {
            a.0 = Some(Instant::now());
            a.1 = on;
        }
    }
    fn snapshot(&self) -> (Option<Instant>, bool) {
        self.0.lock().map(|a| *a).unwrap_or((None, false))
    }
}

/// True when an update may install now: no window in use, and none used for `idle` (never used counts as idle).
pub fn quiet(now: Instant, last_used: Option<Instant>, in_use: bool, idle: Duration) -> bool {
    !in_use && last_used.map_or(true, |t| now.duration_since(t) >= idle)
}

fn settings_file(data: &Path) -> PathBuf {
    data.join("updates.json")
}

/// "Install updates automatically": on unless the file says otherwise.
pub fn auto(data: &Path) -> bool {
    std::fs::read_to_string(settings_file(data))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("auto").and_then(|a| a.as_bool()))
        .unwrap_or(true)
}

pub fn set_auto(data: &Path, on: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(data)?;
    std::fs::write(settings_file(data), serde_json::json!({ "auto": on }).to_string())
}

/// The version an update said it installed, if this start is that version: once, then forgotten.
pub fn take_updated_to(data: &Path, running: &str) -> Option<String> {
    let path = data.join("updated-to");
    let version = std::fs::read_to_string(&path).ok()?.trim().to_string();
    let _ = std::fs::remove_file(&path);
    (version == running).then_some(version)
}

/// The Settings toggle (web app): `on` given sets it; the answer is the setting now.
#[tauri::command]
pub fn app_auto_update(app: AppHandle, on: Option<bool>) -> Result<bool, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(on) = on {
        set_auto(&data, on).map_err(|e| e.to_string())?;
    }
    Ok(auto(&data))
}

/// Runs for the app's life: says once which version this is after an update, then checks every EVERY.
pub async fn run(app: AppHandle, stop_server: fn(&AppHandle)) {
    let Ok(data) = app.path().app_data_dir() else { return };
    let running = app.package_info().version.to_string();
    if let Some(version) = take_updated_to(&data, &running) {
        app.dialog().message(format!("Veritas was updated to {version}.")).title("Veritas updated").show(|_| {});
    }
    loop {
        check_once(&app, &data, stop_server).await;
        tokio::time::sleep(EVERY).await;
    }
}

async fn check_once(app: &AppHandle, data: &Path, stop_server: fn(&AppHandle)) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return }; // offline or no newer release
    if !auto(data) {
        offer(app, update, stop_server);
        return;
    }
    let Ok(bytes) = update.download(|_, _| {}, || {}).await else { return }; // tried again at the next check
    loop {
        let (last, in_use) = app.state::<Activity>().snapshot();
        if quiet(Instant::now(), last, in_use, IDLE) {
            break;
        }
        tokio::time::sleep(POLL).await;
    }
    let _ = std::fs::write(data.join("updated-to"), &update.version);
    if update.install(bytes).is_ok() {
        stop_server(app);
        app.restart();
    }
    let _ = std::fs::remove_file(data.join("updated-to"));
}

/// The setting off: ask, as before spec 033.
fn offer(app: &AppHandle, update: tauri_plugin_updater::Update, stop_server: fn(&AppHandle)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_waits_until_veritas_is_not_in_use() {
        let now = Instant::now();
        let ago = |s: u64| Some(now - Duration::from_secs(s));
        assert!(quiet(now, None, false, IDLE), "never used: installs");
        assert!(!quiet(now, ago(3600), true, IDLE), "in use now: waits");
        assert!(!quiet(now, ago(60), false, IDLE), "used a minute ago: waits");
        assert!(quiet(now, ago(16 * 60), false, IDLE), "unused for 16 minutes: installs");
    }

    #[test]
    fn the_setting_is_on_unless_turned_off_and_the_update_note_is_said_once() {
        let dir = std::env::temp_dir().join(format!("veritas-updates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(auto(&dir));
        set_auto(&dir, false).unwrap();
        assert!(!auto(&dir));
        set_auto(&dir, true).unwrap();
        assert!(auto(&dir));
        std::fs::write(dir.join("updated-to"), "0.55.2").unwrap();
        assert_eq!(take_updated_to(&dir, "0.55.1"), None, "a failed install: nothing to say, and the note is gone");
        std::fs::write(dir.join("updated-to"), "0.55.2").unwrap();
        assert_eq!(take_updated_to(&dir, "0.55.2").as_deref(), Some("0.55.2"));
        assert_eq!(take_updated_to(&dir, "0.55.2"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
