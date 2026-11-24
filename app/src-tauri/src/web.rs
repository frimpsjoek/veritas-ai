//! The web app ships inside the app (resources/web) and the server serves it from `<data>/web` at /app/, the same
//! place `web/install.sh` fills for a source install. Copied once per build: the stamp is the app version plus the
//! bundled index.html, which names the build's hashed scripts, so a rebuild under the same version still installs.

use std::fs;
use std::path::Path;

const STAMP: &str = ".desktop-app-version";

/// Copies the bundled web app into `<data>/web` when this app version has not done so yet. Each file goes in by
/// rename and index.html / login.html last, so a page never names a script that is not there yet; the server's own
/// files in that folder (state.json, sessions.json, pending-adds.json) are never touched.
pub fn install(bundled: &Path, data: &Path) -> Result<(), String> {
    let dest = data.join("web");
    let index = fs::read_to_string(bundled.join("index.html")).unwrap_or_default();
    let stamp = stamp_for(env!("CARGO_PKG_VERSION"), &index);
    if fs::read_to_string(dest.join(STAMP)).ok().as_deref() == Some(stamp.as_str()) {
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
    fs::write(dest.join(STAMP), stamp).map_err(|e| e.to_string())
}

/// "0.54.0 <hash of index.html>": two builds of one version ship different hashed scripts, and index.html names them.
/// Comparing a stamp from an older Rust only costs one extra copy.
fn stamp_for(version: &str, index: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    index.hash(&mut hasher);
    format!("{version} {:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("veritas-web-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_rebuild_under_the_same_version_installs_its_new_scripts() {
        let (bundled, data) = (folder("bundled"), folder("data"));
        fs::write(bundled.join("index.html"), r#"<script src="app-aaaa.js">"#).unwrap();
        fs::write(bundled.join("app-aaaa.js"), "old").unwrap();
        install(&bundled, &data).unwrap();
        assert!(data.join("web/app-aaaa.js").exists());

        fs::remove_file(bundled.join("app-aaaa.js")).unwrap();
        fs::write(bundled.join("index.html"), r#"<script src="app-bbbb.js">"#).unwrap();
        fs::write(bundled.join("app-bbbb.js"), "new").unwrap();
        install(&bundled, &data).unwrap();
        assert_eq!(fs::read_to_string(data.join("web/app-bbbb.js")).unwrap(), "new");
        assert!(!data.join("web/app-aaaa.js").exists(), "the older build's script is removed");
        assert!(fs::read_to_string(data.join("web/index.html")).unwrap().contains("app-bbbb.js"));
    }

    #[test]
    fn the_stamp_changes_with_the_index_and_not_otherwise() {
        assert_eq!(stamp_for("0.54.0", "a"), stamp_for("0.54.0", "a"));
        assert_ne!(stamp_for("0.54.0", "a"), stamp_for("0.54.0", "b"));
        assert_ne!(stamp_for("0.54.0", "a"), stamp_for("0.55.0", "a"));
    }
}
