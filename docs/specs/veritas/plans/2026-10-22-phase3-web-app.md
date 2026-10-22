# Veritas Phase 3 — Web App on Its Own Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app runs from any host (GitHub Pages, the Tauri window, or the server's own `/app/`) and connects to whichever Veritas server it is given: setup screen with server URL + token, Bearer auth, CORS for allowed web-app origins, images and PDFs through fetch, single-use tickets for the browser-panel iframe, a QR link that carries server and token, built with Vite.

**Architecture:** The server keeps refusing other websites, except origins on an allow-list (`data/web-origins.json`), which get CORS headers and must send the Bearer token on every request. The web app stores its servers in `localStorage` and sends `Authorization: Bearer` when it is not on the server's own origin; on the server's own origin it keeps the cookie sign-in. Everything a page cannot attach a header to (an `<img>`, PDF.js, an `<iframe>`) goes through `fetch` → blob URL, or a one-use ticket in the iframe's URL.

**Tech Stack:** Python server (http.server), browser JS (`// @ts-check`, node --test), Vite 6 (build + dev server), GitHub Actions Pages workflow.

**Spec:** `docs/specs/veritas/2026-10-22-veritas-design.md` goal 3, constraints (Bearer, CORS, HTTPS), calls (blob URLs, tickets, GitHub Pages host-agnostic build).

## Global Constraints

- Repo is public: no personal host names, tokens or paths in committed files.
- Other websites are still refused (403). Only listed origins pass, and they never get the cookie path or the loopback free pass: they must send `Authorization: Bearer <token>`.
- The long-lived token never goes into a URL except the QR/sign-in link's `#fragment` (never sent to a server). Iframes get tickets: one use, 120 s, bound to one route and its query.
- `localStorage` key `veritas.servers` = `[{ "url": string, "token": string, "name": string }]`, `veritas.current` = url. Same-origin use (`/app/` served by the server) needs no entry.
- Sign-in link format: `<web app URL>#server=<encoded server URL>&t=<token>` (the app also keeps accepting the old `/app/login#t=<token>`).
- A server URL that is plain `http://` and not `localhost`/`127.0.0.1` gets a visible warning in setup: a page on HTTPS cannot reach it.
- Same-origin behaviour of `/app/` must not change (cookie sign-in, phone link).

## Review Focus

1. **An allowed origin calling without a token from loopback** must get 401, not the local free pass → Task 1 test `test_allowed_origin_still_needs_token_on_loopback`.
2. **A ticket replayed or used for another route** → Task 2 tests `test_ticket_is_single_use`, `test_ticket_bound_to_route_and_query`.
3. **Blob URLs leaking memory** when a reader closes or a list re-renders → Task 4 test `revokes blob URLs it made when the view closes`.
4. **Switching server keeps the old server's data on screen** → Task 3 test `switching server clears cached views`.
5. **Vite build drops the lazy PDF.js chunk or the login page** → Task 6 check `dist-web has index.html, login.html, pdf-*.mjs, pdf-worker-*.mjs`.

---

### Task 1: Allowed web-app origins and CORS (server)

**Files:** Create `server/web_origins.py`; modify `server/http_api.py` (`request_class`, `_allowed`, `_send` headers, new `do_OPTIONS`), `server/kb.py` CLI. Test: `server/tests/test_web_origins.py`.

**Interfaces:** `web_origins.allowed() -> set[str]` (from `data/web-origins.json` `{"origins": [...]}` plus env `VERITAS_WEB_ORIGINS`, comma-separated; normalised `scheme://host[:port]`); `web_origins.add(origin)`, `remove(origin)`; `request_class` returns `"app"` for an allowed `Origin`. `_allowed`: `"app"` passes only with a valid Bearer token. Every response to an `"app"` request carries `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`; `OPTIONS` preflight → 204 with `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 600`, and `Access-Control-Allow-Private-Network: true` when asked. CLI `kb.py web-origins [list|add|remove] [ORIGIN]`.
- [ ] Tests: `test_unlisted_origin_still_refused`, `test_allowed_origin_with_token_gets_cors_headers`, `test_allowed_origin_still_needs_token_on_loopback`, `test_preflight_answers_allowed_origin_only`, `test_origins_from_env_and_file`.

### Task 2: Single-use tickets (server)

**Files:** Create `server/tickets.py`; modify `server/http_api.py`. Test: `server/tests/test_tickets.py`.

**Interfaces:** `POST /web/ticket {"route": "/web/page" | "/web/pdf" | "/zotero/pdf" | "/file" | "/folder-file", "query": {..}}` (authorised) → `{"ticket": str, "expires_in": 120}`. A GET to that route with `?ticket=<t>` and exactly that query (ticket param aside) is authorised once. `tickets.issue(route, query) -> str`, `tickets.redeem(ticket, route, query) -> bool`.
- [ ] Tests: `test_ticket_opens_its_route_once`, `test_ticket_is_single_use`, `test_ticket_bound_to_route_and_query`, `test_ticket_expires`, `test_ticket_route_needs_auth`.

### Task 3: Connections and setup screen (web)

**Files:** Create `web/src/connection.js`, `web/src/setup-view.js`; modify `web/src/index.js`, `web/src/host.js`, `web/src/transport.js`, `web/src/login.js`, `web/src/shell.js` (Settings > Server). Tests: `web/test/connection.test.js`.

**Interfaces:** `connection.js`: `loadServers(storage) -> Server[]`, `saveServer(storage, server)`, `currentServer(storage, location) -> Server | { url: location.origin, token: null, sameOrigin: true } | null`, `parseSignInHash(hash) -> { server?: string, token?: string } | null` (both formats), `needsHttpsWarning(pageUrl, serverUrl) -> boolean`, `normaliseServerUrl(text) -> string` (adds `http://` for `host:port`, strips trailing `/`). `createFetchApi(base, { token })` sends `Authorization: Bearer` when `token`. Boot: sign-in hash → save + strip from the address bar; no server and not same-origin → setup view.
- [ ] Tests: `parses both sign-in link formats`, `same origin needs no saved server`, `warns for plain http to another host from an https page`, `transport sends the bearer token`, `switching server clears cached views`.

### Task 4: Images, PDFs and frames without cookies (web + ui)

**Files:** Create `web/src/assets.js`; modify `ui/src/sources/view-kit.js` (image URLs through a host hook `host.assetUrl?.(path)`), `web/src/paper-view.js`, `web/src/browser-panel.js`, `web/src/pdf-viewer.js` (accept `{ data }` as well as `{ url }`). Tests: `web/test/assets.test.js`.

**Interfaces:** `createAssets({ base, token, fetch, URL })` → `{ url(path): Promise<string> }` (same origin: returns `path` unchanged; otherwise fetch with Bearer → `URL.createObjectURL`), `.bytes(path): Promise<ArrayBuffer>`, `.frame(route, query): Promise<string>` (same origin: plain URL; otherwise `POST /web/ticket` then `<base><route>?<query>&ticket=`), `.revokeAll()`.
- [ ] Tests: `same origin keeps plain paths`, `cross origin fetches with the token and returns a blob URL`, `frames get a ticket URL`, `revokes blob URLs it made when the view closes`.

### Task 5: Sign-in link carries the server (server)

**Files:** Modify `server/web_app.py` (`phone_link`), `server/http_api.py` (`GET /web/phone-link` adds `app_url` when `data/web-app-url` or env `VERITAS_WEB_APP_URL` is set). Test: `server/tests/test_web_app.py` additions.

**Interfaces:** with a web app URL configured: `{"url": "<web app URL>#server=<this server's https URL>&t=<token>", ...}`; without: unchanged `/app/login#t=`.
- [ ] Tests: `test_phone_link_points_at_hosted_app_when_set`, existing phone-link tests unchanged.

### Task 6: Vite build (web)

**Files:** Create `web/vite.config.mjs`, `web/index.html`, `web/login.html` (Vite entries); modify `web/package.json` (`build`: `vite build`, `dev`: `vite`, devDependency `vite`), `web/install.sh` (unchanged contract: `dist-web/`), remove the esbuild `web/build.mjs` once parity holds; `check.sh`.

**Interfaces:** `npm run build` → `dist-web/` with `index.html`, `login.html`, hashed `assets/*.js|css`, PDF.js as separate lazy chunks, the same manifest/icon/fonts/covers; `base` from env `VERITAS_WEB_BASE` (default `./`, so the build works under `/app/`, `/veritas-ai/` and `tauri://`). `npm run dev` proxies API routes to `VERITAS_DEV_SERVER` (default `http://127.0.0.1:27182`).
- [ ] Checks: build output list as in Review Focus 5; `web/install.sh` into a scratch `KB`; `npm test` (web) unchanged.

### Task 7: GitHub Pages workflow (inert until Joseph enables Pages)

**Files:** Create `.github/workflows/web-pages.yml` (on push to main touching `web/**` or `ui/**`: `npm ci` in ui and web, `VERITAS_WEB_BASE=/veritas-ai/ npm run build`, `actions/upload-pages-artifact`, `actions/deploy-pages`).
- [ ] Check: workflow YAML parses; no secrets used.

### Task 8: Evidence

- [ ] Serve `web/dist-web` from a second local origin (`python3 -m http.server 8765`), allow `http://127.0.0.1:8765` on the smoke server (port 27191), and record with curl: preflight 204 + headers; data call without token 401, with token 200 + CORS header; ticket single use. Record in `docs/specs/veritas/phase3-evidence.md`.
