//! The Veritas server as a sidecar: started on a localhost port with its data in the app-data folder, stopped when
//! the app quits. The server starts the agent sidecar (agentd) itself, as it does in every other install.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The port every other Veritas install uses, so the Zotero and Obsidian plugins find the app without settings.
const USUAL_PORT: u16 = 27182;
const START_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Server {
    child: Child,
    data: PathBuf,
    pub port: u16,
}

/// A sidecar binary: Tauri puts each `externalBin` next to the app's own executable, without the target suffix.
fn sidecar(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe
        .parent()
        .ok_or("the app's folder is unknown")?
        .join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{} is missing from the app; reinstall Veritas", path.display()))
    }
}

/// 27182 when it is free (a Homebrew or source install may hold it), else any free port. The port is part of the
/// web app's address, so keeping the usual one also keeps the web app's sign-in across restarts.
fn free_port() -> Result<u16, String> {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, USUAL_PORT)).is_ok() {
        return Ok(USUAL_PORT);
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| format!("no free port: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

fn log_tail(log: &Path) -> String {
    let mut text = String::new();
    if let Ok(mut file) = fs::File::open(log) {
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = file.seek(SeekFrom::Start(len.saturating_sub(1500)));
        let _ = file.read_to_string(&mut text);
    }
    text.trim().to_string()
}

/// The server executable with this install's settings: one place for what `serve` and `import-data` both need.
fn server_command(data: &Path) -> Result<Command, String> {
    let agentd = sidecar("agentd")?;
    let mut command = Command::new(sidecar("veritas-server")?);
    command
        .env("VERITAS_DATA", data)
            .env("KB_BACKEND", "onnx")
            // agent_api.py runs `<SECOND_BRAIN_NODE> <SECOND_BRAIN_AGENTD_ENTRY> ...`; agentd is one executable
            // (Node SEA) that ignores the entry argument, so both name it (packaging/sea/build.mjs).
            .env("SECOND_BRAIN_NODE", &agentd)
            .env("SECOND_BRAIN_AGENTD_ENTRY", &agentd)
            .current_dir(data)
            .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // the server is a console program; no console window
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

/// Runs `veritas-server import-data <args>` (server/import_data.py) and returns what it printed (JSON).
fn import_data(data: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    let out = server_command(data)?
        .arg("import-data")
        .args(args)
        .output()
        .map_err(|e| format!("could not run the server: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("unexpected answer from import-data: {e}"))
}

/// The indexes other installs on this computer already built, most preferred first.
pub fn find_indexes(data: &Path) -> Vec<serde_json::Value> {
    match import_data(data, &["--find"]) {
        Ok(serde_json::Value::Array(found)) => found,
        _ => Vec::new(), // nothing to offer is the safe answer; the user can still pick a folder
    }
}

/// Copies another install's index into this one (read-only on the other side), so nothing is embedded again.
pub fn import_index(data: &Path, from: &str) -> Result<serde_json::Value, String> {
    import_data(data, &[from])
}

/// True when this install has no index yet: the moment to offer one from elsewhere.
pub fn first_start(data: &Path) -> bool {
    !data.join("kb.sqlite").exists()
}

impl Server {
    pub fn start(data: &Path) -> Result<Server, String> {
        let port = free_port()?;
        let logs = data.join("logs");
        fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
        let log_path = logs.join("server.log");
        let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
        let mut command = server_command(data)?;
        command
            .args(["serve", "--port", &port.to_string()])
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        // A group of its own, so stopping it reaches every process it is made of: the one-file launcher, the
        // Python process it unpacks and runs, and agentd. Signalling only the launcher left the others running.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn().map_err(|e| format!("could not start the server: {e}"))?;
        let mut started = Server { child, data: data.to_path_buf(), port };
        started.wait_ready(&log_path)?;
        Ok(started)
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/app/", self.port)
    }

    /// The server answers /ping as soon as it is running, before it has read the folders or opened the index, so the
    /// wait is for its `ready`: the window then moves to a web app whose routes work. The first start also unpacks the
    /// server (PyInstaller one-file), so this allows a while. A folder macOS has not allowed yet holds it up here too.
    fn wait_ready(&mut self, log: &Path) -> Result<(), String> {
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("the server stopped ({status}). Its log says:\n{}", log_tail(log)));
            }
            if ping(self.port).is_some_and(|answer| is_ready(&answer)) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        self.stop();
        Err(format!(
            "the server was not ready within {} s; if macOS is asking for Documents access, allow it and Retry. Its log says:\n{}",
            START_TIMEOUT.as_secs(),
            log_tail(log)
        ))
    }

    /// Asks the server's process group to stop (the server stops agentd on the way out) and kills the group if
    /// it has not after 5 s; then stops an indexing run the server started, which runs in a session of its own.
    pub fn stop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            signal_group(&self.child, false);
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && matches!(self.child.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(100));
            }
            signal_group(&self.child, true); // whatever is left of the group, also once the launcher is gone
            let _ = self.child.wait();
        }
        stop_indexing(&self.data);
    }
}

#[cfg(unix)]
fn signal_group(child: &Child, kill: bool) {
    let signal = if kill { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), signal);
    }
}

#[cfg(windows)]
fn signal_group(child: &Child, kill: bool) {
    // Windows has no SIGTERM: the whole tree is ended at once (the launcher, the server and agentd).
    if kill {
        return;
    }
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .creation_flags(0x0800_0000)
        .output();
}

/// A full indexing run is a separate process (http_api.start_indexing) that outlives a server restart on purpose;
/// when the app quits it must stop too. Its pid is in index-progress.json while it runs; SIGTERM makes it finish
/// the current batch and leave.
fn stop_indexing(data: &Path) {
    let Ok(text) = fs::read_to_string(data.join("index-progress.json")) else { return };
    let Ok(progress) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let (Some(true), Some(pid)) = (progress["running"].as_bool(), progress["pid"].as_u64()) else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).output();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What `GET /ping` answers, whole: a plain request, since a blocking HTTP client for one health check is not worth
/// its weight. The server closes the connection after each answer.
fn ping(port: u16) -> Option<String> {
    use std::io::Write;
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    stream.write_all(b"GET /ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").ok()?;
    let mut answer = String::new();
    stream.read_to_string(&mut answer).ok()?;
    Some(answer)
}

/// A 200 whose body does not say `"ready": false`.
fn is_ready(answer: &str) -> bool {
    let Some((head, body)) = answer.split_once("\r\n\r\n") else { return false };
    if !(head.starts_with("HTTP/1.") && head.get(9..12) == Some("200")) {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body).is_ok_and(|ping| ping["ready"].as_bool() != Some(false))
}

/// The enabled folders in a sources.json (server/sources.py); an online source has no path.
fn enabled_folders(listed: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let Ok(listed) = serde_json::from_str::<serde_json::Value>(listed) else { return Vec::new() };
    let folders = listed["folders"].as_array().map(Vec::as_slice).unwrap_or_default();
    folders
        .iter()
        .filter(|folder| folder["enabled"].as_bool() != Some(false))
        .filter_map(|folder| folder["path"].as_str())
        .map(|path| match (path.strip_prefix("~/"), home) {
            (Some(rest), Some(home)) => home.join(rest),
            _ => PathBuf::from(path),
        })
        .collect()
}

/// Opens each enabled folder from this process, the visible app, so a macOS permission prompt for ~/Documents is asked
/// by something the user can see (the server is a background child). On a thread of its own, since the call blocks
/// until the prompt is answered and the start must go on regardless; what the folder holds does not matter here.
pub fn look_at_source_folders(data: &Path) {
    let list = data.join("sources.json");
    std::thread::spawn(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let listed = fs::read_to_string(list).unwrap_or_default();
        for folder in enabled_folders(&listed, home.as_deref()) {
            let _ = fs::read_dir(folder).map(|mut entries| entries.next());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_ready_answer_ends_the_wait() {
        let ping = |body: &str| format!("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{body}");
        assert!(!is_ready(&ping(r#"{"ok": true, "ready": false}"#)));
        assert!(is_ready(&ping(r#"{"ok": true, "ready": true}"#)));
        assert!(is_ready(&ping(r#"{"ok": true}"#)), "absent means ready");
        assert!(!is_ready("HTTP/1.0 503 Service Unavailable\r\n\r\n{}"));
        assert!(!is_ready(""));
    }

    #[test]
    fn the_folders_to_look_at_are_the_enabled_ones_with_a_path() {
        let listed = r#"{"version": 1, "folders": [
            {"name": "vault", "path": "/Users/a/Documents/Vault", "enabled": true},
            {"name": "unsaid", "path": "/Users/a/Documents/Notes"},
            {"name": "off", "path": "/Users/a/Documents/Off", "enabled": false},
            {"name": "web", "kind": "zotero-web", "user_id": "1", "enabled": true}
        ]}"#;
        let found = enabled_folders(listed, Some(Path::new("/Users/a")));
        assert_eq!(found, [PathBuf::from("/Users/a/Documents/Vault"), PathBuf::from("/Users/a/Documents/Notes")]);
    }

    #[test]
    fn a_folder_written_from_home_is_found_and_a_broken_list_is_no_folders() {
        let found = enabled_folders(r#"{"folders": [{"path": "~/Documents/Vault"}]}"#, Some(Path::new("/Users/a")));
        assert_eq!(found, [PathBuf::from("/Users/a/Documents/Vault")]);
        assert!(enabled_folders("not json", None).is_empty());
    }

    /// A FIFO nobody writes to: reading it blocks for good, as a folder under an unanswered macOS prompt does.
    #[cfg(unix)]
    #[test]
    fn looking_at_the_folders_never_holds_up_the_start() {
        let data = std::env::temp_dir().join(format!("veritas-look-{}", std::process::id()));
        fs::create_dir_all(&data).unwrap();
        let list = std::ffi::CString::new(data.join("sources.json").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(list.as_ptr(), 0o600) }, 0);
        let before = Instant::now();
        look_at_source_folders(&data);
        assert!(before.elapsed() < Duration::from_secs(1));
        let _ = fs::remove_dir_all(&data);
    }
}
