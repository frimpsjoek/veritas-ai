//! The web app ships inside the app (resources/web) and the server serves it from `<data>/web` at /app/, the same
//! place `web/install.sh` fills for a source install. Copied once per app version, the way install.sh does it.

use std::fs;
use std::path::Path;

const STAMP: &str = ".desktop-app-version";

/// Copies the bundled web app into `<data>/web` when this app version has not done so yet. Each file goes in by
/// rename and index.html / login.html last, so a page never names a script that is not there yet; the server's own
/// files in that folder (state.json, sessions.json, pending-adds.json) are never touched.
pub fn install(bundled: &Path, data: &Path) -> Result<(), String> {
    let dest = data.join("web");
    let version = env!("CARGO_PKG_VERSION");
    if fs::read_to_string(dest.join(STAMP)).ok().as_deref() == Some(version) {
        return Ok(());
    }
    fs::create_dir_all(&dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let mut names: Vec<String> = fs::read_dir(bundled)
        .map_err(|e| format!("the app's web files are missing ({}): {e}", bundled.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    if !names.iter().any(|n| n == "index.html") {
        return Err(format!("the app's web files are incomplete: no index.html in {}", bundled.display()));
    }
    names.sort_by_key(|n| matches!(n.as_str(), "index.html" | "login.html"));
    for name in &names {
        let fresh = dest.join(format!(".{name}.new"));
        fs::copy(bundled.join(name), &fresh).map_err(|e| format!("cannot copy {name}: {e}"))?;
        fs::rename(&fresh, dest.join(name)).map_err(|e| format!("cannot install {name}: {e}"))?;
    }
    // hashed scripts and styles of older builds (app-/login-/pdf-<hash>) that this build does not ship
    for entry in fs::read_dir(&dest).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let hashed = ["app-", "login-", "pdf-"].iter().any(|p| name.starts_with(p));
        if hashed && !names.contains(&name) {
            let _ = fs::remove_file(entry.path());
        }
    }
    fs::write(dest.join(STAMP), version).map_err(|e| e.to_string())
}
