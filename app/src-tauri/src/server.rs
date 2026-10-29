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

    /// The first start unpacks the server (PyInstaller one-file) and opens the index, so this allows a while.
    fn wait_ready(&mut self, log: &Path) -> Result<(), String> {
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("the server stopped ({status}). Its log says:\n{}", log_tail(log)));
            }
            if answers(self.port, "/ping") {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        self.stop();
        Err(format!("the server did not answer within {} s. Its log says:\n{}", START_TIMEOUT.as_secs(), log_tail(log)))
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

/// True when `http://127.0.0.1:<port>/<path>` answers 200: a plain GET, since a blocking HTTP client for one
/// health check is not worth its weight.
fn answers(port: u16, path: &str) -> bool {
    use std::io::Write;
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.") && &head[9..12] == b"200"
}
