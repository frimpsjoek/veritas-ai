//! Browse (spec 027): publishers' pages in the desktop app, as native webviews over the web app's Browse view.
//!
//! The web app (main webview, local server origin) drives the tabs with the `browse_*` commands and hears back through
//! `browse://state`, `browse://saved`, `browse://new-tab` and `browse://closed`. Pages in the tabs get two commands
//! only, `browse_pdf_info` and `browse_pdf_bytes`, and both do nothing without the one-shot token of a Save press
//! (rules::Guard). Tabs keep their own data store, so a sign-in lasts across restarts and "Sign out of sites" clears
//! only Browse.
pub mod rules;
#[cfg(target_os = "macos")]
mod webkit;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Runtime, State, Url, Webview, WebviewUrl};

pub const MAX_TABS: usize = 8;
const LABEL_PREFIX: &str = "browse-";
/// Browse's own WebKit data store (macOS 14+): cookies and sign-ins, apart from the web app's store.
pub const STORE: [u8; 16] = *b"veritas-browse01";
const MAIN: &str = "main";
const SAVE_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a page has to make the first call of a Save (browse_pdf_info) before the Save ends: a page whose script
/// cannot run (a PDF viewer, a page that went away) would otherwise sit on "Saving…" for the token's two minutes.
const FIRST_ANSWER: Duration = Duration::from_secs(15);

/// What Browse keeps: the open tabs (id, last opened or shown), the one on screen, the Save guard and the Save in
/// progress per token, and where the server is (set by `boot`).
#[derive(Default)]
pub struct Tabs(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    open: Vec<(String, Instant)>,
    shown: Option<String>,
    guard: rules::Guard,
    saves: HashMap<String, Save>,
    server: Option<(String, PathBuf)>,
}

/// What a page said about itself when its Save started (browse_pdf_info), kept until its file arrives.
#[derive(Clone)]
struct Save {
    doi: String,
    title: String,
    pdf: String,
}

impl Tabs {
    /// The local server's address (`http://127.0.0.1:<port>`) and the data folder that holds its `api-token`.
    pub fn set_server(&self, base: String, data: PathBuf) {
        if let Ok(mut inner) = self.0.lock() {
            inner.server = Some((base, data));
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.0.lock().map_err(|_| "Browse is in a bad state; restart Veritas".to_string())
    }
}

/// A rectangle in CSS pixels of the main webview, which fills the window.
#[derive(Clone, Copy, Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageState {
    tab: String,
    url: String,
    title: String,
    can_go_back: bool,
    can_go_forward: bool,
    loading: bool,
}

fn to_web_app<R: Runtime, S: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    // only the main webview: the tabs are webviews of the same window and must not hear these
    let _ = app.emit_to(EventTarget::webview(MAIN), event, payload);
}

fn saved<R: Runtime>(app: &AppHandle<R>, tab: &str, status: &str, message: Option<String>) {
    to_web_app(app, "browse://saved", serde_json::json!({ "tab": tab, "status": status, "message": message }));
}

/// The tab a ninth one closes: the one opened or shown longest ago, never the one on screen.
pub fn evict(open: &[(String, Instant)], shown: &str) -> Option<String> {
    open.iter().filter(|(tab, _)| tab != shown).min_by_key(|(_, at)| *at).map(|(tab, _)| tab.clone())
}

/// The major version in a macOS product version ("14.2.1" -> 14).
fn major(version: &str) -> Option<u32> {
    version.split('.').next()?.trim().parse().ok()
}

/// A tab's webview label: the web app's tab id (letters, digits, `-`, `_`; up to 40) after "browse-".
fn label(tab: &str) -> Result<String, String> {
    let ok = (1..=40).contains(&tab.len()) && tab.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { Ok(format!("{LABEL_PREFIX}{tab}")) } else { Err("a tab id is 1 to 40 letters, digits, - or _".into()) }
}

fn tab_of(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX).filter(|tab| !tab.is_empty())
}

/// Browse is offered on macOS 14 and later (its own data store needs it) and on Windows and Linux.
#[tauri::command]
pub fn browse_available() -> bool {
    available()
}

#[cfg(target_os = "macos")]
fn available() -> bool {
    let mut buf = [0u8; 32];
    let mut len = buf.len();
    // SAFETY: a NUL-terminated name and a buffer whose length is passed in `len`
    let found = unsafe { libc::sysctlbyname(c"kern.osproductversion".as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } == 0;
    found && std::str::from_utf8(&buf[..len.min(buf.len())]).ok().map(|v| v.trim_end_matches('\0')).and_then(major).is_some_and(|v| v >= 14)
}

#[cfg(not(target_os = "macos"))]
fn available() -> bool {
    true
}

/// Opens `text` (a link or a DOI, rules::address_target) in the tab, making the tab's webview when it is new. A ninth
/// tab closes the one used longest ago that is not on screen.
#[tauri::command]
pub async fn browse_open<R: Runtime>(app: AppHandle<R>, tabs: State<'_, Tabs>, tab: String, text: String) -> Result<(), String> {
    if !available() {
        return Err("Browse needs macOS 14 or later".into());
    }
    let target = rules::address_target(&text).map_err(String::from)?;
    let name = label(&tab)?;
    if let Some(webview) = app.get_webview(&name) {
        return webview.navigate(target).map_err(|e| e.to_string());
    }
    let evicted = {
        let inner = tabs.lock()?;
        if inner.open.len() >= MAX_TABS { evict(&inner.open, inner.shown.as_deref().unwrap_or("")) } else { None }
    };
    if let Some(old) = evicted {
        close(&app, &tabs, &old);
        to_web_app(&app, "browse://closed", serde_json::json!({ "tab": old }));
    }
    let data = tabs.lock()?.server.as_ref().map(|(_, data)| data.clone());
    make(&app, &tab, &name, target, data)?;
    tabs.lock()?.open.push((tab, Instant::now()));
    Ok(())
}

fn make<R: Runtime>(app: &AppHandle<R>, tab: &str, name: &str, target: Url, data: Option<PathBuf>) -> Result<(), String> {
    let window = app.get_window(MAIN).ok_or("the window is gone")?;
    // On macOS the page starts blank, so the ad and tracker rules are in place before the site's first request.
    let first = if cfg!(target_os = "macos") { Url::parse("about:blank").expect("a fixed url") } else { target.clone() };
    let for_new = app.clone();
    let from = tab.to_string();
    let builder = WebviewBuilder::new(name, WebviewUrl::External(first))
        // a page may go to web pages, never to files, scripts or other apps
        // and never to this computer or the local network, where the Veritas server answers (rules::public_web)
        .on_navigation(|url| matches!(url.scheme(), "about" | "blob" | "data") || rules::public_web(url))
        .on_new_window(move |url, _| {
            if rules::public_web(&url) {
                to_web_app(&for_new, "browse://new-tab", serde_json::json!({ "from": from, "url": url.to_string() }));
            }
            NewWindowResponse::Deny
        })
        // the only file that leaves a page is Save PDF to Zotero's; a site's own PDF link shows inline
        .on_download(|_, _| false)
        .on_page_load(|webview, payload| report(&webview, Some(payload.url().to_string()), matches!(payload.event(), PageLoadEvent::Started)))
        .on_document_title_changed(|webview, _| report(&webview, None, false));
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(STORE);
    #[cfg(not(target_os = "macos"))]
    let builder = match data {
        Some(data) => builder.data_directory(data.join("browse")),
        None => builder,
    };
    #[cfg(target_os = "macos")]
    let _ = data;
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| format!("could not open the page: {e}"))?;
    let _ = webview.hide();
    #[cfg(target_os = "macos")]
    webkit::block_ads_then(&webview, target);
    Ok(())
}

/// Sends the tab's address, title and history state to the web app. Called from the page's own handlers, which
/// run on the main thread, so it never waits on the webview.
fn report<R: Runtime>(webview: &Webview<R>, url: Option<String>, loading: bool) {
    let Some(tab) = tab_of(webview.label()).map(str::to_string) else { return };
    let app = webview.app_handle().clone();
    #[cfg(target_os = "macos")]
    webkit::read_state(webview, move |state| {
        to_web_app(&app, "browse://state", PageState {
            tab,
            url: if state.url.is_empty() { url.unwrap_or_default() } else { state.url },
            title: state.title,
            can_go_back: state.can_go_back,
            can_go_forward: state.can_go_forward,
            loading: loading || state.loading,
        });
    });
    #[cfg(not(target_os = "macos"))]
    to_web_app(&app, "browse://state", PageState { tab, url: url.unwrap_or_default(), title: String::new(), can_go_back: true, can_go_forward: true, loading });
}

/// Puts the tab over `rect` and shows it; every other tab is hidden.
#[tauri::command]
pub fn browse_show<R: Runtime>(app: AppHandle<R>, tabs: State<'_, Tabs>, tab: String, rect: Rect) -> Result<(), String> {
    let name = label(&tab)?;
    let mut inner = tabs.lock()?;
    for (open, _) in &inner.open {
        if *open != tab {
            if let Some(webview) = app.get_webview(&format!("{LABEL_PREFIX}{open}")) {
                let _ = webview.hide();
            }
        }
    }
    let webview = app.get_webview(&name).ok_or("no such tab")?;
    let top = title_bar(&app);
    let bounds = tauri::Rect {
        position: LogicalPosition::new(rect.x.max(0.0), rect.y.max(0.0) + top).into(),
        size: LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)).into(),
    };
    webview.set_bounds(bounds).map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())?;
    if let Some(entry) = inner.open.iter_mut().find(|(open, _)| *open == tab) {
        entry.1 = Instant::now();
    }
    inner.shown = Some(tab);
    Ok(())
}

/// How far below the window's top the web app starts, in logical pixels. On macOS a child webview is placed from
/// the top of the window frame, title bar included (seen in the installed app: pages drawn one title bar too high),
/// while the web app measures from under it.
fn title_bar<R: Runtime>(app: &AppHandle<R>) -> f64 {
    if !cfg!(target_os = "macos") {
        return 0.0;
    }
    let Some(window) = app.get_window(MAIN) else { return 0.0 };
    let (Ok(outer), Ok(inner), Ok(scale)) = (window.outer_size(), window.inner_size(), window.scale_factor()) else { return 0.0 };
    frame_offset(outer.height, inner.height, scale)
}

/// The title bar's height from the window's outer and inner heights (physical pixels).
fn frame_offset(outer: u32, inner: u32, scale: f64) -> f64 {
    if scale <= 0.0 { 0.0 } else { f64::from(outer.saturating_sub(inner)) / scale }
}

/// Hides every tab: another view, a dialog or a menu is over Browse.
#[tauri::command]
pub fn browse_hide<R: Runtime>(app: AppHandle<R>, tabs: State<'_, Tabs>) -> Result<(), String> {
    let mut inner = tabs.lock()?;
    for (open, _) in &inner.open {
        if let Some(webview) = app.get_webview(&format!("{LABEL_PREFIX}{open}")) {
            let _ = webview.hide();
        }
    }
    inner.shown = None;
    Ok(())
}

fn tab_webview<R: Runtime>(app: &AppHandle<R>, tab: &str) -> Result<Webview<R>, String> {
    app.get_webview(&label(tab)?).ok_or_else(|| "no such tab".to_string())
}

#[tauri::command]
pub fn browse_back<R: Runtime>(app: AppHandle<R>, tab: String) -> Result<(), String> {
    tab_webview(&app, &tab)?.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browse_forward<R: Runtime>(app: AppHandle<R>, tab: String) -> Result<(), String> {
    tab_webview(&app, &tab)?.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browse_reload<R: Runtime>(app: AppHandle<R>, tab: String) -> Result<(), String> {
    tab_webview(&app, &tab)?.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browse_close<R: Runtime>(app: AppHandle<R>, tabs: State<'_, Tabs>, tab: String) -> Result<(), String> {
    label(&tab)?;
    close(&app, &tabs, &tab);
    Ok(())
}

fn close<R: Runtime>(app: &AppHandle<R>, tabs: &Tabs, tab: &str) {
    if let Some(webview) = app.get_webview(&format!("{LABEL_PREFIX}{tab}")) {
        let _ = webview.close();
    }
    if let Ok(mut inner) = tabs.lock() {
        inner.open.retain(|(open, _)| open != tab);
        if inner.shown.as_deref() == Some(tab) {
            inner.shown = None;
        }
    }
}

/// Closes every tab and removes Browse's data store: cookies, sign-ins and site storage of Browse only.
#[tauri::command]
pub async fn browse_sign_out<R: Runtime>(app: AppHandle<R>, tabs: State<'_, Tabs>) -> Result<(), String> {
    let open: Vec<String> = tabs.lock()?.open.iter().map(|(tab, _)| tab.clone()).collect();
    for tab in &open {
        close(&app, &tabs, tab);
        to_web_app(&app, "browse://closed", serde_json::json!({ "tab": tab }));
    }
    #[cfg(target_os = "macos")]
    {
        // WebKit refuses to remove a store a webview still uses; closing is asynchronous
        for _ in 0..20 {
            match app.remove_data_store(STORE).await {
                Ok(()) => return Ok(()),
                Err(_) => tokio_sleep(Duration::from_millis(250)).await,
            }
        }
        Err("Could not clear the sites' sign-ins; quit Veritas and try again".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let data = tabs.lock()?.server.as_ref().map(|(_, data)| data.clone());
        if let Some(data) = data {
            let _ = std::fs::remove_dir_all(data.join("browse"));
        }
        Ok(())
    }
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

/// Save PDF to Zotero: issues the press's token and runs the save script in the page; the outcome arrives as
/// `browse://saved` (saving, then added | queued | already | failed).
#[tauri::command]
pub fn browse_save_pdf<R: Runtime>(app: AppHandle<R>, tabs: State<'_, Tabs>, tab: String) -> Result<(), String> {
    let webview = tab_webview(&app, &tab)?;
    let token = tabs.lock()?.guard.issue(&tab, Instant::now());
    saved(&app, &tab, "saving", None);
    if let Err(error) = webview.eval(save_script(&token)) {
        tabs.lock()?.guard.cancel(&tab, &token);
        saved(&app, &tab, "failed", Some(format!("Could not reach the page: {error}")));
        return Ok(());
    }
    let (early_app, early_tab, early_token) = (app.clone(), tab.clone(), token.clone());
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_ANSWER);
        let state = early_app.state::<Tabs>();
        let ended = state.lock().map(|mut inner| {
            let silent = inner.guard.holds(&early_tab, &early_token, Instant::now()) && !inner.saves.contains_key(&early_token);
            silent && inner.guard.cancel(&early_tab, &early_token)
        }).unwrap_or(false);
        if ended {
            saved(&early_app, &early_tab, "failed", Some("The page did not answer; reload it and press Save again".into()));
        }
    });
    let (app, tab) = (app.clone(), tab.clone());
    std::thread::spawn(move || {
        // the page took the token and never answered (a fetch that hangs, a page that went away)
        std::thread::sleep(rules::TOKEN_TTL + Duration::from_secs(5));
        let state = app.state::<Tabs>();
        let ended = state.lock().map(|mut inner| inner.guard.cancel(&tab, &token)).unwrap_or(false);
        if ended {
            saved(&app, &tab, "failed", Some("No PDF came from the page; try again".into()));
        }
    });
    Ok(())
}

/// The script a Save runs in the page: it reads the page's DOI, title and PDF address, asks the app which address to
/// fetch (rules::pdf_address), fetches it with the page's cookies, and hands the bytes over as base64.
fn save_script(token: &str) -> String {
    format!(
        r#"(async () => {{
  const token = {token:?};
  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const meta = (name) => (document.querySelector(`meta[name="${{name}}" i]`) || {{}}).content || "";
  try {{
    const address = await call("browse_pdf_info", {{ token, page: location.href, pdf: document.contentType === "application/pdf" ? location.href : meta("citation_pdf_url"),
      doi: meta("citation_doi") || meta("dc.identifier"), title: meta("citation_title") || meta("dc.title") || document.title }});
    const response = await fetch(address, {{ credentials: "include" }});
    const bytes = new Uint8Array(await response.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    await call("browse_pdf_bytes", {{ token, data: btoa(text), error: null }});
  }} catch (e) {{
    try {{ await call("browse_pdf_bytes", {{ token, data: null, error: String((e && e.message) || e).slice(0, 200) }}); }} catch (_) {{}}
  }}
}})();"#
    )
}

/// The page's first call in a Save: what it says about itself. Answers the PDF address to fetch.
#[tauri::command]
pub fn browse_pdf_info<R: Runtime>(
    webview: Webview<R>,
    tabs: State<'_, Tabs>,
    token: String,
    page: String,
    pdf: Option<String>,
    doi: Option<String>,
    title: Option<String>,
) -> Result<String, String> {
    let tab = tab_of(webview.label()).ok_or("not a Browse tab")?.to_string();
    let app = webview.app_handle().clone();
    let mut inner = tabs.lock()?;
    if !inner.guard.holds(&tab, &token, Instant::now()) {
        return Err("no Save in progress".into());
    }
    let page = Url::parse(&page).map_err(|_| "a page address".to_string())?;
    let doi = doi.as_deref().and_then(rules::doi_of).or_else(|| rules::doi_in(&page));
    let Some(address) = rules::pdf_address(&page, pdf.as_deref(), doi.as_deref()) else {
        inner.guard.cancel(&tab, &token);
        drop(inner);
        saved(&app, &tab, "failed", Some("No PDF on this page".into()));
        return Err("no PDF on this page".into());
    };
    let title: String = title.unwrap_or_default().trim().chars().take(500).collect();
    inner.saves.insert(token, Save { doi: doi.unwrap_or_default(), title, pdf: address.to_string() });
    Ok(address.to_string())
}

/// The page's second call: the PDF (base64), or what went wrong. The Guard decides; the file goes to the server.
#[tauri::command]
pub async fn browse_pdf_bytes<R: Runtime>(
    webview: Webview<R>,
    tabs: State<'_, Tabs>,
    token: String,
    data: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let tab = tab_of(webview.label()).ok_or("not a Browse tab")?.to_string();
    let app = webview.app_handle().clone();
    let (save, server) = {
        let mut inner = tabs.lock()?;
        let save = inner.saves.remove(&token);
        if let Some(error) = error {
            if inner.guard.cancel(&tab, &token) {
                drop(inner);
                saved(&app, &tab, "failed", Some(format!("Could not fetch the PDF: {}", error.chars().take(200).collect::<String>())));
            }
            return Ok(());
        }
        let encoded = data.unwrap_or_default();
        let bytes = if encoded.len() > rules::MAX_PDF / 3 * 4 + 8 {
            Err("The PDF is larger than 200 MB")
        } else {
            base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).map_err(|_| rules::NOT_A_PDF)
        };
        let checked = bytes.and_then(|bytes| inner.guard.accept(&tab, &token, Instant::now(), &bytes).map(|()| bytes));
        match (checked, save) {
            (Ok(bytes), Some(save)) => ((bytes, save), inner.server.clone()),
            (Err(message), _) => {
                inner.guard.cancel(&tab, &token);
                drop(inner);
                saved(&app, &tab, "failed", Some(message.into()));
                return Ok(());
            }
            (Ok(_), None) => {
                drop(inner);
                saved(&app, &tab, "failed", Some("The page skipped a step of the Save; press it again".into()));
                return Ok(());
            }
        }
    };
    let ((bytes, save), Some((base, data))) = (save, server) else {
        saved(&app, &tab, "failed", Some("The Veritas server is not running".into()));
        return Ok(());
    };
    let (status, message) = send(&base, &data, bytes, &save).await;
    saved(&app, &tab, status, message);
    Ok(())
}

/// POST /zotero/attach-pdf (server/pending_adds.attach_pdf) and the button state its answer means.
async fn send(base: &str, data: &std::path::Path, bytes: Vec<u8>, save: &Save) -> (&'static str, Option<String>) {
    let mut url = match Url::parse(&format!("{base}/zotero/attach-pdf")) {
        Ok(url) => url,
        Err(e) => return ("failed", Some(e.to_string())),
    };
    url.query_pairs_mut().append_pair("doi", &save.doi).append_pair("title", &save.title).append_pair("url", &save.pdf);
    let mut request = reqwest::Client::new()
        .post(url)
        .timeout(SAVE_TIMEOUT)
        .header("Content-Type", "application/pdf")
        .body(bytes);
    if let Ok(token) = std::fs::read_to_string(data.join("api-token")) {
        request = request.bearer_auth(token.trim());
    }
    let reply = match request.send().await {
        Ok(response) => response.bytes().await.ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()),
        Err(_) => return ("failed", Some("The Veritas server did not answer".into())),
    };
    let Some(reply) = reply else { return ("failed", Some("The Veritas server sent an answer Browse cannot read".into())) };
    outcome(&reply)
}

/// The server's answer as the Save button's state. An add the plugin reports as already there is "already".
fn outcome(reply: &serde_json::Value) -> (&'static str, Option<String>) {
    let message = reply.get("message").or_else(|| reply.get("error")).and_then(|m| m.as_str()).map(str::to_string);
    match reply.get("status").and_then(|s| s.as_str()) {
        Some("added") if reply.get("already").and_then(|a| a.as_bool()) == Some(true) => ("already", None),
        Some("added") => ("added", None),
        Some("queued") => ("queued", None),
        // spec 032: no Zotero library, so the PDF went to Veritas's own Papers folder
        Some("kept") => ("kept", None),
        _ => ("failed", Some(message.unwrap_or_else(|| "The PDF could not be saved".into()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_ninth_tab_closes_the_oldest_not_shown() {
        let t0 = Instant::now();
        let open: Vec<(String, Instant)> = (0..8).map(|i| (format!("t{i}"), t0 + Duration::from_secs(i))).collect();
        assert_eq!(evict(&open, "t3").as_deref(), Some("t0"));
        assert_eq!(evict(&open, "t0").as_deref(), Some("t1"));
        assert_eq!(evict(&[("t0".into(), t0)], "t0"), None);
        assert_eq!(evict(&[], ""), None);
    }

    #[test]
    fn the_server_answer_is_the_button_state() {
        use serde_json::json;
        assert_eq!(outcome(&json!({"status": "added", "id": "x", "key": "K"})), ("added", None));
        assert_eq!(outcome(&json!({"status": "added", "already": true, "key": "K"})), ("already", None));
        assert_eq!(outcome(&json!({"status": "queued", "id": "x"})), ("queued", None));
        assert_eq!(outcome(&json!({"status": "kept", "where": "folder", "path": "Papers/A.pdf"})), ("kept", None));
        assert_eq!(outcome(&json!({"status": "failed", "message": "Saving PDFs works with a local Zotero library for now"})),
                   ("failed", Some("Saving PDFs works with a local Zotero library for now".into())));
        assert_eq!(outcome(&json!({"error": "needs_zotero"})), ("failed", Some("needs_zotero".into())));
        assert_eq!(outcome(&json!({})), ("failed", Some("The PDF could not be saved".into())));
    }

    #[test]
    fn the_save_script_carries_its_token_as_a_string() {
        let script = save_script("ab12");
        assert!(script.contains(r#"const token = "ab12";"#));
        assert!(script.contains("browse_pdf_info") && script.contains("browse_pdf_bytes"));
        assert!(script.contains(r#"credentials: "include""#));
        // a page that is the PDF itself (a site's own PDF link shows inline): its address is the PDF
        assert!(script.contains(r#"document.contentType === "application/pdf" ? location.href"#));
    }

    #[test]
    fn a_save_whose_page_never_answers_ends_soon() {
        assert!(FIRST_ANSWER < rules::TOKEN_TTL);
        assert!(FIRST_ANSWER <= Duration::from_secs(15));
    }

    #[test]
    fn the_title_bar_is_the_frame_minus_the_content() {
        assert_eq!(frame_offset(1776, 1720, 2.0), 28.0);
        assert_eq!(frame_offset(860, 860, 1.0), 0.0);
        assert_eq!(frame_offset(800, 900, 2.0), 0.0);
        assert_eq!(frame_offset(900, 800, 0.0), 0.0);
    }

    #[test]
    fn the_macos_major_version() {
        assert_eq!(major("14.2.1"), Some(14));
        assert_eq!(major("26.0"), Some(26));
        assert_eq!(major("13"), Some(13));
        assert_eq!(major(""), None);
        assert_eq!(major("x.1"), None);
    }

    #[test]
    fn a_tab_label_is_its_id_after_browse() {
        assert_eq!(label("tab-1_a").unwrap(), "browse-tab-1_a");
        assert_eq!(tab_of("browse-tab-1_a"), Some("tab-1_a"));
        assert_eq!(tab_of("main"), None);
        assert_eq!(tab_of("browse-"), None);
        for bad in ["", "a b", "../x", "a:b", &"x".repeat(41)] {
            assert!(label(bad).is_err(), "{bad}");
        }
    }
}
