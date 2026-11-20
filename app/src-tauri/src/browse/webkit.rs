//! The macOS parts of Browse that Tauri does not cover: WebKit's content rules (ads and trackers) and a page's
//! history state, read from the tab's WKWebView.
use objc2::rc::Retained;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};
use tauri::{Runtime, Url, Webview};

const RULES: &str = include_str!("blocklist.json");
const RULES_ID: &str = "veritas-browse-blocklist";

pub struct State {
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
}

fn wk(platform: &tauri::webview::PlatformWebview) -> &WKWebView {
    // SAFETY: on macOS `inner()` is the tab's WKWebView, alive for the closure's duration
    unsafe { &*(platform.inner() as *const WKWebView) }
}

/// Compiles the block list (WebKit keeps the compiled list under RULES_ID), adds it to the tab, then loads `target`.
/// A list that fails to compile leaves the tab without it; the page still loads.
pub fn block_ads_then<R: Runtime>(webview: &Webview<R>, target: Url) {
    let tab = webview.clone();
    let _ = webview.with_webview(move |platform| {
        let view: Retained<WKWebView> = unsafe { Retained::retain(platform.inner() as *mut WKWebView) }.expect("a webview");
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            let _ = tab.navigate(target);
            return;
        };
        let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
            let _ = tab.navigate(target);
            return;
        };
        let rules = NSString::from_str(RULES);
        let id = NSString::from_str(RULES_ID);
        let pending = std::cell::RefCell::new(Some((tab, target)));
        let done = block2::RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
            if let Some(list) = unsafe { list.as_ref() } {
                unsafe { view.configuration().userContentController().addContentRuleList(list) };
            } else if let Some(error) = unsafe { error.as_ref() } {
                eprintln!("Browse: the ad block list did not compile: {}", error.localizedDescription());
            }
            if let Some((tab, target)) = pending.borrow_mut().take() {
                let _ = tab.navigate(target);
            }
        });
        unsafe { store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(Some(&id), Some(&rules), Some(&done)) };
    });
}

/// Reads the tab's address, title and history state on the main thread and hands them to `then`.
pub fn read_state<R: Runtime>(webview: &Webview<R>, then: impl FnOnce(State) + Send + 'static) {
    let _ = webview.with_webview(move |platform| {
        let view = wk(&platform);
        let state = unsafe {
            State {
                url: view.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()).unwrap_or_default(),
                title: view.title().map(|t| t.to_string()).unwrap_or_default(),
                can_go_back: view.canGoBack(),
                can_go_forward: view.canGoForward(),
                loading: view.isLoading(),
            }
        };
        then(state);
    });
}
