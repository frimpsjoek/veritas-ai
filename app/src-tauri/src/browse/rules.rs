//! Browse's pure rules (spec 027): what the address field goes to, where a page's PDF is, and the one-shot guard on
//! the PDF hand-over from a page to the app (D3).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::Url;

pub const MAX_PDF: usize = 200 * 1024 * 1024;
pub const TOKEN_TTL: Duration = Duration::from_secs(120);
pub const NOT_A_LINK: &str = "Type a link or a DOI";
pub const NOT_A_PDF: &str = "The site sent a page, not the PDF (sign in first?)";

/// The address field's text as a page to open: an http(s) link as given, a DOI as its doi.org link, nothing else (no
/// web search, no other schemes).
pub fn address_target(text: &str) -> Result<Url, &'static str> {
    let text = text.trim();
    if let Some(doi) = bare_doi(text) {
        return Ok(doi_url("https://doi.org/", doi));
    }
    match Url::parse(text) {
        Ok(url) if public_web(&url) => Ok(url),
        _ => Err(NOT_A_LINK),
    }
}

/// A DOI given as text (a page's `citation_doi` or `dc.identifier`), without its `doi:` or doi.org prefix.
pub fn doi_of(text: &str) -> Option<String> {
    bare_doi(text.trim()).map(str::to_string)
}

/// An http(s) page on the public web: not this computer, the local network or a tailnet, where the Veritas server
/// and other private services answer.
pub fn public_web(url: &Url) -> bool {
    use std::net::IpAddr;
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !(name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") || name.ends_with(".ts.net") || name.ends_with(".internal"))
        }
        Some(url::Host::Ipv4(ip)) => {
            let [a, b, ..] = ip.octets();
            !(ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast()
                || (a == 100 && (64..128).contains(&b))) // shared / tailnet addresses (100.64.0.0/10)
        }
        Some(url::Host::Ipv6(ip)) => {
            let ip = IpAddr::V6(ip);
            !(ip.is_loopback() || ip.is_unspecified() || matches!(ip, IpAddr::V6(v) if (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80))
        }
        None => false,
    }
}

/// `10.<4-9 digits>/<suffix>`, after an optional `doi:` or doi.org prefix; the suffix has no spaces.
fn bare_doi(text: &str) -> Option<&str> {
    let lower = text.to_ascii_lowercase();
    let skip = ["doi:", "https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/"]
        .iter()
        .find(|p| lower.starts_with(*p))
        .map_or(0, |p| p.len());
    let doi = text[skip..].trim();
    let rest = doi.strip_prefix("10.")?;
    let (prefix, suffix) = rest.split_once('/')?;
    let ok = (4..=9).contains(&prefix.len()) && prefix.bytes().all(|b| b.is_ascii_digit())
        && !suffix.is_empty() && !suffix.chars().any(char::is_whitespace);
    ok.then_some(doi)
}

fn doi_url(base: &str, doi: &str) -> Url {
    let mut url = Url::parse(base).expect("a fixed base");
    let path = format!("{}{}", url.path(), doi);
    url.set_path(&path); // percent-encodes `?`, `#`, `<`, `>` and spaces, so the DOI stays one path
    url
}

/// Where a page's PDF is: its `citation_pdf_url` (http or https, made absolute against the page), else ACS's own
/// path for the DOI on an ACS page or for an ACS DOI (10.1021), else none.
pub fn pdf_address(page_url: &Url, meta_pdf: Option<&str>, doi: Option<&str>) -> Option<Url> {
    if let Some(found) = meta_pdf.map(str::trim).filter(|m| !m.is_empty()).and_then(|m| page_url.join(m).ok()) {
        if matches!(found.scheme(), "http" | "https") {
            return Some(found);
        }
    }
    let doi = doi.and_then(bare_doi)?;
    let acs_page = page_url.host_str().is_some_and(|h| h == "pubs.acs.org" || h.ends_with(".pubs.acs.org"));
    (acs_page || doi.starts_with("10.1021/")).then(|| doi_url("https://pubs.acs.org/doi/pdf/", doi))
}

/// One token per Save press: it lets one file through, from the tab it was made for, within TOKEN_TTL, up to MAX_PDF,
/// and only a PDF. A token is spent by its first use, right or wrong.
#[derive(Default)]
pub struct Guard {
    open: HashMap<String, (String, Instant)>,
}

impl Guard {
    pub fn issue(&mut self, tab: &str, now: Instant) -> String {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("the system's random source");
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.open.insert(tab.to_string(), (token.clone(), now));
        token
    }

    pub fn accept(&mut self, tab: &str, token: &str, now: Instant, body: &[u8]) -> Result<(), &'static str> {
        if token.is_empty() {
            return Err("no Save in progress");
        }
        let owner = self.open.iter().find(|(_, (t, _))| same(t, token)).map(|(k, _)| k.clone()).ok_or("no Save in progress")?;
        let (_, issued) = self.open.remove(&owner).expect("found above");
        if owner != tab {
            return Err("this Save belongs to another tab");
        }
        if now.saturating_duration_since(issued) > TOKEN_TTL {
            return Err("the Save took too long; press it again");
        }
        if body.len() > MAX_PDF {
            return Err("The PDF is larger than 200 MB");
        }
        if !body.starts_with(b"%PDF-") {
            return Err(NOT_A_PDF);
        }
        Ok(())
    }
}

impl Guard {
    /// Whether `token` is this tab's open Save, still in time (the page's first call, before the file).
    pub fn holds(&self, tab: &str, token: &str, now: Instant) -> bool {
        self.open.get(tab).is_some_and(|(t, issued)| !token.is_empty() && same(t, token) && now.saturating_duration_since(*issued) <= TOKEN_TTL)
    }

    /// Ends this tab's Save without a file; true when it was still open (the watchdog, a page that reported an error).
    pub fn cancel(&mut self, tab: &str, token: &str) -> bool {
        let open = self.open.get(tab).is_some_and(|(t, _)| !token.is_empty() && same(t, token));
        if open {
            self.open.remove(tab);
        }
        open
    }
}

/// The DOI in a page's address (`/doi/10.1021/x`, `/doi/pdf/10.1021/x`, doi.org links), when the page has no DOI meta.
pub fn doi_in(url: &Url) -> Option<String> {
    let path = percent_decode(url.path());
    let mut from = 0;
    while let Some(at) = path[from..].find("/10.") {
        let candidate = path[from + at + 1..].trim_end_matches('/');
        if let Some(doi) = bare_doi(candidate) {
            return Some(doi.to_string());
        }
        from += at + 1;
    }
    None
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[i], bytes.get(i + 1).and_then(|b| hex(*b)), bytes.get(i + 2).and_then(|b| hex(*b))) {
            (b'%', Some(hi), Some(lo)) => {
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Compares two tokens without stopping at the first different byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn an_address_is_a_link_or_a_doi() {
        assert_eq!(address_target("https://pubs.acs.org/doi/10.1021/x").unwrap(), url("https://pubs.acs.org/doi/10.1021/x"));
        assert_eq!(address_target("  http://example.org/a ").unwrap(), url("http://example.org/a"));
        let doi = url("https://doi.org/10.1021/acsnano.6c11666");
        assert_eq!(address_target("10.1021/acsnano.6c11666").unwrap(), doi);
        assert_eq!(address_target("doi:10.1021/acsnano.6c11666").unwrap(), doi);
        assert_eq!(address_target("https://doi.org/10.1021/acsnano.6c11666").unwrap(), doi);
        for text in ["vole burrows", "javascript:alert(1)", "file:///etc/passwd", "", "10.12/x", "data:text/html,hi"] {
            assert_eq!(address_target(text), Err(NOT_A_LINK), "{text}");
        }
    }

    #[test]
    fn a_tab_never_goes_to_this_computer_or_the_local_network() {
        for text in ["http://127.0.0.1:27182/app/", "http://localhost/x", "http://[::1]/", "http://10.0.0.2/", "http://192.168.1.4/",
                     "http://172.20.0.1/", "http://100.101.102.103/", "http://mac.local/", "http://0.0.0.0/", "https://mac.tail1234.ts.net/app/"] {
            assert_eq!(address_target(text), Err(NOT_A_LINK), "{text}");
            assert!(!public_web(&url(text)), "{text}");
        }
        for text in ["https://pubs.acs.org/doi/10.1021/x", "https://172.15.0.1/", "https://100.200.0.1/"] {
            assert!(public_web(&url(text)), "{text}");
        }
        assert!(!public_web(&url("file:///etc/passwd")));
    }

    #[test]
    fn a_doi_with_odd_characters_is_kept_as_a_path() {
        let target = address_target("10.1002/(SICI)1097-4628(19960705)61:1<1::AID-APP1>3.0.CO;2-X").unwrap();
        assert_eq!(target.host_str(), Some("doi.org"));
        assert!(target.path().starts_with("/10.1002/"));
        assert!(target.query().is_none() && target.fragment().is_none());
    }

    #[test]
    fn the_pdf_address_comes_from_the_page_then_the_doi() {
        let page = url("https://pubs.acs.org/doi/10.1021/x");
        assert_eq!(pdf_address(&page, Some("/doi/pdf/10.1021/x"), None).unwrap(), url("https://pubs.acs.org/doi/pdf/10.1021/x"));
        assert_eq!(pdf_address(&page, None, Some("10.1021/x")).unwrap(), url("https://pubs.acs.org/doi/pdf/10.1021/x"));
        let aps = url("https://journals.aps.org/prb/abstract/10.1103/y");
        assert_eq!(pdf_address(&aps, None, Some("10.1103/y")), None);
        assert_eq!(pdf_address(&page, Some("javascript:alert(1)"), Some("10.1021/x")).unwrap(), url("https://pubs.acs.org/doi/pdf/10.1021/x"));
        assert_eq!(pdf_address(&aps, Some("javascript:alert(1)"), None), None);
        let other = url("https://www.nature.com/articles/s1");
        assert_eq!(pdf_address(&other, Some("https://www.nature.com/articles/s1.pdf"), None).unwrap(), url("https://www.nature.com/articles/s1.pdf"));
        // an ACS page whose DOI is not 10.1021 (a partner journal) still gets ACS's path
        assert_eq!(pdf_address(&page, None, Some("10.31635/c")).unwrap(), url("https://pubs.acs.org/doi/pdf/10.31635/c"));
    }

    #[test]
    fn a_token_is_used_once() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let token = guard.issue("t1", now);
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(guard.accept("t1", &token, now, b"%PDF-1.7"), Ok(()));
        assert!(guard.accept("t1", &token, now, b"%PDF-1.7").is_err());
    }

    #[test]
    fn two_tokens_differ() {
        let mut guard = Guard::default();
        let now = Instant::now();
        assert_ne!(guard.issue("t1", now), guard.issue("t2", now));
    }

    #[test]
    fn no_token_no_file() {
        let mut guard = Guard::default();
        assert!(guard.accept("t1", "", Instant::now(), b"%PDF-1.7").is_err());
        assert!(guard.accept("t1", &"0".repeat(64), Instant::now(), b"%PDF-1.7").is_err());
    }

    #[test]
    fn a_token_from_another_tab_is_refused() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let token = guard.issue("t1", now);
        assert!(guard.accept("t2", &token, now, b"%PDF-1.7").is_err());
        // and it is spent: the right tab cannot use it after a misuse
        assert!(guard.accept("t1", &token, now, b"%PDF-1.7").is_err());
    }

    #[test]
    fn a_token_after_two_minutes_is_refused() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let token = guard.issue("t1", now);
        assert!(guard.accept("t1", &token, now + TOKEN_TTL + Duration::from_secs(1), b"%PDF-1.7").is_err());
    }

    #[test]
    fn more_than_200_mb_is_refused() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let token = guard.issue("t1", now);
        let mut body = b"%PDF-".to_vec();
        body.resize(MAX_PDF + 1, b' ');
        assert!(guard.accept("t1", &token, now, &body).is_err());
    }

    #[test]
    fn a_body_that_is_not_a_pdf_is_refused() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let token = guard.issue("t1", now);
        assert_eq!(guard.accept("t1", &token, now, b"<!doctype html>"), Err(NOT_A_PDF));
    }

    #[test]
    fn a_save_is_held_until_its_file_or_its_end() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let token = guard.issue("t1", now);
        assert!(guard.holds("t1", &token, now));
        assert!(!guard.holds("t2", &token, now));
        assert!(!guard.holds("t1", "nope", now));
        assert!(!guard.holds("t1", &token, now + TOKEN_TTL + Duration::from_secs(1)));
        assert!(guard.holds("t1", &token, now), "holds does not spend the token");
        assert!(!guard.cancel("t2", &token));
        assert!(guard.cancel("t1", &token));
        assert!(!guard.cancel("t1", &token));
        assert!(!guard.holds("t1", &token, now));
        assert!(guard.accept("t1", &token, now, b"%PDF-1.7").is_err());
    }

    #[test]
    fn a_doi_from_a_meta_tag() {
        assert_eq!(doi_of(" doi:10.1021/x ").as_deref(), Some("10.1021/x"));
        assert_eq!(doi_of("https://doi.org/10.1021/x").as_deref(), Some("10.1021/x"));
        assert_eq!(doi_of("ISSN 1234-5678"), None);
    }

    #[test]
    fn the_doi_in_a_page_address() {
        assert_eq!(doi_in(&url("https://pubs.acs.org/doi/10.1021/acsnano.6c11666")).as_deref(), Some("10.1021/acsnano.6c11666"));
        assert_eq!(doi_in(&url("https://pubs.acs.org/doi/pdf/10.1021/x?ref=a")).as_deref(), Some("10.1021/x"));
        assert_eq!(doi_in(&url("https://doi.org/10.1103/PhysRevB.1.2")).as_deref(), Some("10.1103/PhysRevB.1.2"));
        assert_eq!(doi_in(&url("https://onlinelibrary.wiley.com/doi/full/10.1002/anie.2024%2F1")).as_deref(), Some("10.1002/anie.2024/1"));
        assert_eq!(doi_in(&url("https://pubs.acs.org/ancac3/article/20/43/28994/5454152/Low-Energy")), None);
        assert_eq!(doi_in(&url("https://example.org/10.12/x")), None);
    }

    #[test]
    fn a_new_save_on_a_tab_replaces_its_old_token() {
        let mut guard = Guard::default();
        let now = Instant::now();
        let old = guard.issue("t1", now);
        let new = guard.issue("t1", now);
        assert!(guard.accept("t1", &old, now, b"%PDF-1.7").is_err());
        assert_eq!(guard.accept("t1", &new, now, b"%PDF-1.7"), Ok(()));
    }
}
