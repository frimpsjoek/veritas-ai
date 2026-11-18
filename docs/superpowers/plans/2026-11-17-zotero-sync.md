# Hosted Zotero WebDAV Implementation Plan

> **For agentic workers:** Implement this plan task-by-task via the `feature-development` skill (its plan-review → TDD → independent-review-loop steps). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide native, tenant-isolated Zotero WebDAV attachment synchronization with one-time Basic credentials and durable 50-GiB pool/per-user quotas.

**Architecture:** Zotero metadata remains on `zotero.org`; this PR only implements desktop Zotero's native attachment protocol. One Python storage service owns a transactional SQLite ledger and immutable per-version blob files. A narrow native HTTP dispatcher handles DAV before ordinary Veritas auth, while existing verified Globus principals access a small management API and web settings panel.

**Tech Stack:** Python 3.12 stdlib HTTP server/SQLite/PBKDF2, Node 22 web tests, Zotero 8 WebDAV client behavior; no new package dependency, background scheduler, tenant search index, or Zotero metadata service.

---

## Change record and boundaries

- Owner/session: Huihuo Zheng / current OpenCode session; inline execution was selected for this PR request.
- Worktree: `/home/hzheng/Documents/Research/AmSC/agentic_workflows/projects/platforms/veritas/veritas-ai/worktrees/veritas-zotero-sync`
- Branch `veritas-zotero-sync`; intended base `zhenghh04/veritas-ai:main` at `7f17671d1792414e75cd673c260ed7e3838497be`.
- Dependency: the fork's Globus identity support. Upstream PR `frimpsjoek/veritas-ai#3` separately carries those prerequisites.
- Next action: second independent plan review, then Task 1.
- Follow-up dependency, not in this PR: personal Zotero Web API connection, delta metadata sync, personal index/search.
- Non-goals: native metadata hosting, groups' attachments, remote Obsidian, personal PDF readback, Veritas metadata write-back, deployment.
- Plan-review disposition: the first GPT-6 Sol review's metadata-generation/searcher findings are removed with that subsystem; durable upload states, default-disabled configuration, canonical HTTPS, proxy tests, and failure-injection checks are adopted below. The fourth review reached PROCEED WITH CHANGES; its mandatory collector-gate, post-commit cleanup, fixed OPTIONS discovery, concrete public-Host, and marker-scope changes are incorporated before implementation.

### File structure

- Create `server/zotero_storage.py`: validated public configuration, credential verifiers, quota ledger, immutable blobs, recovery.
- Create `server/webdav.py`: exact native namespace parsing/authentication, bounded DAV/XML and byte streaming.
- Modify `server/http_api.py`: initialize a none/disabled service, exact Globus management routes, early native dispatch, watcher entries.
- Create `web/src/zotero-storage-view.js`; modify `web/src/pages.js`, `ui/src/settings/settings-schema.js`.
- Create `server/tests/test_zotero_storage.py`, `test_webdav.py`, `test_zotero_storage_http.py`, `web/test/zotero-storage-view.test.js`; modify existing schema/security tests only as required.
- Update `docs/guide/globus-alcf.md`, `docs/guide/privacy.md`, `docs/guide/architecture.md`, `docs/README.md`, and spec 025.

### Task 1: Default-disabled configuration and management credential APIs

**Files:** `server/zotero_storage.py`, `server/http_api.py`, `server/tests/test_zotero_storage_http.py`, `server/tests/test_http_security.py`

- [ ] **Step 1: Write failing configuration/capability tests.** Construct configuration directly in unit tests and use the existing fake two-user Globus HTTP fixture. Assert:

```python
assert public_config("https://veritas.example/webdav").base == "https://veritas.example/webdav"
for bad in (None, "", "http://veritas.example/webdav", "https://u:p@host/webdav",
            "https://host/other", "https://host/webdav?x=1", "https://host/webdav#x"):
    with pytest.raises((ValueError, StorageDisabled)):
        public_config(bad).require_enabled()
```

For a valid configured service, only GET `/zotero-storage` is readable by a valid Globus principal. POST `/zotero-storage/credentials` requires that same principal; DELETE revokes. No body or `X-Veritas-Tenant` value can select another tenant. Admin Bearer/cookie, A2A, no/expired session, malformed body, and unknown method follow explicit 401/403/400/404 responses. With the feature disabled, authenticated management GET returns 200 `{enabled:false}` without opening the ledger, issuance/revocation returns 503, and native paths return 404. UI tests use that exact disabled GET contract.

- [ ] **Step 2: Run and verify the failures precede code.** `KB_BACKEND=onnx .venv/bin/python -m pytest tests/test_zotero_storage_http.py -q -p no:cacheprovider` fails because the module/routes do not exist, while existing security tests establish a green baseline.

- [ ] **Step 3: Implement minimal configuration and service initialization.** `PublicConfig(base: str|None, pool_bytes=50*1024**3, user_bytes=5*1024**3)` parses environment only in `serve()`, never at import. Require positive ASCII decimal quotas with a 19-digit lexical bound and numeric value `<= 2**63 - 1`; refuse values above SQLite's signed integer range and test that boundary plus checked sums. Instantiate `StorageService(users_root, ledger_path, config)` once; no background work or I/O occurs just because tests import the module.

- [ ] **Step 4: Add the exact Globus management capabilities inside `globus_route_allowed()` without granting ordinary admin access.** `_identity.kind == "globus"` is checked again inside handlers, and tenant comes solely from that identity. Bodies use `_body(limit=4096)`. Management verbs already run behind `Handler._allowed()` after `_identity` resolution; its `request_class()`/`kind == "foreign"` check rejects a cross-site POST or DELETE even with a valid cookie, before any route handler. Add explicit cross-site cookie regression tests rather than a second CSRF mechanism. All status JSON is `no-store` and contains only `{enabled, issued, user_used, user_quota, pool_quota}`. Exact aggregate `pool_used` is deliberately omitted from tenant responses; global accounting remains operator-internal. A configured issuance returns `{username,password,endpoint}` exactly once; endpoint is `config.base + "/" + quote(username)` with a generated restricted-character username.

- [ ] **Step 5: Add independent Basic credential storage.** In the same SQLite ledger use:

```sql
CREATE TABLE credentials (
 tenant TEXT PRIMARY KEY CHECK(length(tenant)=64), username TEXT UNIQUE NOT NULL,
 salt BLOB NOT NULL, verifier BLOB NOT NULL, iterations INTEGER NOT NULL, created INTEGER NOT NULL);
```

Issue `vyt_` + 24 URL-safe characters and a 32-byte random password; replace one tenant's record atomically on rotation. Persist PBKDF2-HMAC-SHA256 with random 16-byte salt and 200,000 iterations (tests may use a small explicit constructor-only test value). Compare username and password using constant-time digests; malformed base64/UTF-8 and oversized headers fail identically. Delete revokes. Rotation/revocation blocks subsequent authentication only: a request that already authenticated may finish its bounded upload/download, and a paused test proves this deliberate non-cancellation boundary. Raw passwords never enter status, exceptions, logs, or browser state.

- [ ] **Step 6: Run focused auth/config tests.** New tests plus `test_http_security.py` and the auth fixtures in `test_globus_agent.py` pass. Explicitly test hostile Host/forwarded headers do not alter the returned canonical endpoint.

### Task 2: Durable immutable-blob store and exact quota accounting

**Files:** `server/zotero_storage.py`, `server/tests/test_zotero_storage.py`

- [ ] **Step 1: Write tiny-quota tests before store methods.** Construct a 20-byte pool/10-byte user quota. Cover exact fit and one-byte-over user/global limits, two tenants, ten oversubscribing concurrent reservations, failed/short uploads releasing quota, replacement requiring old+new bytes, and deletion freeing bytes. `QuotaExceeded` maps to 507 only at the HTTP layer. Every refused reservation leaves a spy request stream unread.

- [ ] **Step 2: Implement validated names and owner-only, descriptor-relative paths.** Allow one non-hidden filename of at most 128 ASCII letters/digits/underscore/hyphen/dot with suffix `.zip` or `.prop`; reject everything else, including `lastsync` markers that the targeted upstream client lists only optionally but never requires the server to create or mutate. Tenant IDs follow `user_store.TENANT`; object IDs are server-generated 32-lowercase-hex UUIDs. Roots are:

```python
tenant_root = users_root / tenant / "zotero-storage"
temporary = tenant_root / "uploads" / f"{reservation_id}.tmp"
permanent = tenant_root / "objects" / object_id
```

Starting at the operator-trusted `users_root` directory FD, every tenant/zotero-storage/uploads/objects component is created with `os.mkdir(..., dir_fd=...)`, opened with `O_DIRECTORY|O_NOFOLLOW`, checked with `fstat`, and `fchmod`ed to 0700. Temp/blob create, read, rename, and unlink are relative to those retained directory FDs. A symlink, regular file, or unexpected type at any tenant-relative ancestor aborts before chmod/create/rename/delete. The ledger is no-follow-created beneath the separately operator-trusted data root; remote users cannot redirect it. Never use a request filename as the physical object path. Test symlinks at every ancestor, including tenant root and uploads/objects.

- [ ] **Step 3: Implement the schema, process ownership, and transactional usage.** Use `files(tenant,name,object_id,size,sha256,modified,PRIMARY KEY(tenant,name),UNIQUE(object_id))`, `reservations(id,tenant,name,object_id,size,temp_path,created,state)`, and `garbage(object_id,tenant,size)`. `usage(tenant)` sums active + reservations + garbage for that tenant, and global usage sums all three tables with checked Python arithmetic at `2**63-1` rather than potentially overflowing SQLite SUM. `BEGIN IMMEDIATE` wraps reservation, publication, deletion, and garbage-row removal; `PRAGMA synchronous=FULL` and verified `journal_mode=WAL` are explicitly selected on a local filesystem. Every ledger operation opens a fresh `sqlite3.connect(timeout=30)`, uses it only on its calling thread, and closes it in `finally`. Before any recovery the constructor takes a nonblocking exclusive lifetime `fcntl.flock` on a no-follow mode-0600 lock file beneath the trusted data root; a second process fails `StorageBusy` and cannot recover or serve. Close releases the lifetime lock; process death releases it automatically.

- [ ] **Step 4: Implement reservation/write/publish in the tested order.** Reserve before reading. The handler writes exactly the declared bytes through an `UploadWriter` API:

```python
reservation = store.reserve(tenant, name, length)
try:
    digest = writer.write_to(reservation, stream)  # raises ShortBody on EOF; counts <= declared only
    store.publish(reservation, digest)             # returns created/replaced
except BaseException:
    store.abort(reservation)
    raise
```

`write_to` uses directory-FD-relative creation (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, 0600), bounded 64-KiB reads, `fsync`, and close. `publish` first renames temp to the preallocated object ID relative to verified directory FDs and `fsync`s the object directory. It then executes and **commits** one SQLite transaction installing the active row, moving the old object to `garbage`, and deleting the reservation. Only after that commit does best-effort garbage collection begin. `publish()` returns success once the active row commits; cleanup errors are caught, recorded by type without secret/path details for operator attention, retried by recovery/a later operation, and must not turn a committed PUT into a reported failure or invoke abort. Collection unlinks the old object, `fsync`, and removes its garbage row in a **second transaction**. Unlink is never inside the publication transaction, and `abort` is harmless and idempotent only for a still-uncommitted reservation ID. DELETE similarly commits active-row removal + garbage insertion before unlink, then separately removes the garbage row. Thus a crash before publication preserves old data, after publication preserves complete new data, and around old unlink never leaves a committed active row pointing to a removed object. Garbage rows keep physical bytes counted until collection completes.

- [ ] **Step 5: Specify/test same-name and download ordering with short in-memory open claims, not I/O under a lock.** Concurrent PUT reservations may coexist; publication/deletion commit order decides the visible winner. `open_read` does its DB lookup outside a small `threading.Lock`, then atomically checks an in-memory `retiring_ids` set and increments `opening_claims[object_id]`. Publication/DELETE registers superseded IDs retiring only after their committed garbage row exists. **Every** collection path—including a competing request's garbage scan, deferred collection, and startup recovery after claims are initialized—must enter one `_collect_if_eligible` gate that checks/registers retirement and outstanding claims under the same in-memory lock before any unlink; no path reads the garbage table and unlinks directly. If a reader claimed before that gate, collection defers; if its looked-up ID is already retiring, it re-queries and claims the current version before opening. Add the forced commit → competing collector → retirement registration → reader-claim interleaving to prove the collector cannot outrun either gate. Claims and sets contain generated object IDs and are manipulated only under the in-memory lock—no DB/filesystem/socket I/O is performed there. The actual no-follow open happens outside the lock, then `fstat` validates identity/size and the claim is released. If a deferred object now has zero claims, releaser-triggered garbage collection safely unlinks it (the returned FD remains valid); otherwise the normal collector runs. Unique object IDs prevent ABA. No active read lock spans file opening or response streaming. Force lookup-before-claim, claim-before-retire, and pre-unlink interleavings to prove every successful read returns a complete immutable old/new version.

- [ ] **Step 6: Test real process death and second-instance exclusion, then implement recovery.** An inline worker subprocess reserves/writes/publishes/replaces/deletes, with small internal method boundaries `_rename_reserved`, `_publish_rows`, and `_collect_garbage`; its subclass calls `os._exit(1)` at each boundary. The parent starts only after worker termination, then reopens the store. Explicitly cover kill after reservation, completed temp, rename/fsync before publication commit, immediately after publication commit before old unlink, immediately after old unlink before garbage-row removal, and equivalent DELETE commit/unlink/cleanup boundaries—never an unlink inside the publication transaction. Assert pre-publication reads see complete old data, post-publication reads see complete new data, both reservation paths are reclaimed, and garbage accounting/reconciliation matches every remaining physical byte. A live injected post-commit collector error still returns PUT success, serves the new version, and retains the old garbage/accounting until a subsequent/restart collection succeeds. Exception-in-path tests supplement but do not replace these kills. While a parent owns the live store, a child constructor must fail before any mutation/recovery. At initialization (after `flock`) remove each reservation's temp/preallocated uncommitted object via verified directory FDs, orphaned uploads, and reconciled garbage. Missing/wrong-sized active objects raise `StorageCorrupt`; never silently drop accounting. Use column-generated IDs, not client paths, for recovery.

- [ ] **Step 7: Run focused tests and resource-leak checks.** `KB_BACKEND=onnx .venv/bin/python -m pytest tests/test_zotero_storage.py -q -p no:cacheprovider` passes, including concurrent replacement/DELETE, descriptor integrity, malformed symlink paths, and usage before/after each crash stage.

### Task 3: Native Zotero WebDAV dispatcher and protocol

**Files:** `server/webdav.py`, `server/http_api.py`, `server/tests/test_webdav.py`

- [ ] **Step 1: Write the failing upstream-derived client contract.** A loopback `ThreadingHTTPServer` replays a synthetic fixture derived line-for-line from the observed upstream `Zotero.Sync.Storage.Mode.WebDAV.checkServer` source (`zotero/zotero`, `chrome/content/zotero/xpcom/storage/webdav.js`, reviewed 2026-11-17), including its literal `<propfind xmlns='DAV:'><prop><getcontentlength/></prop></propfind>` body. This is a source-derived contract, not a recorded desktop trace; desktop/proxy verification remains a rollout prerequisite:

```text
OPTIONS /webdav/U/zotero/                       204 + DAV: 1, 2
PROPFIND /webdav/U/zotero/ Depth: 0             207
PUT /webdav/U/zotero/zotero-test-file.prop      201, then 204 on replacement
GET /webdav/U/zotero/zotero-test-file.prop      200 b" "
GET /webdav/U/zotero/nonexistent.prop           404
DELETE /webdav/U/zotero/zotero-test-file.prop   204
MKCOL /webdav/U/zotero/                         405 (already exists)
```

Add `.zip` multi-chunk round-trip/hash, HEAD = GET metadata without body, Depth-0/1 XML collection/resource properties, `.prop` bytes unchanged, delete missing 404, and B credentials unable to access A even with identical filenames.

- [ ] **Step 2: Write failing hostile request tests.** Missing/wrong Basic on loopback/proxy returns 401 with a fixed realm, without reading bodies. Browser/admin/A2A credentials are rejected as Basic. Cross-site requests are refused first. Define the inbound transport before auth: `ipaddress.ip_address(handler.client_address[0]).is_loopback` is mandatory; a direct Host-local request with no proxy headers is the sole development exception; every other request must have exactly one `X-Forwarded-Proto: https` and the configured canonical Host. Missing/multiple/http schemes, wrong Host, untrusted forwarded headers, and simulated non-loopback peers fail before reading Authorization/body. Production's actual edge already terminates TLS and overwrites `X-Forwarded-Proto: https`; binding to 127.0.0.1 makes that loopback peer the only admissible transport. Include a concrete production-shaped request using configured `https://veritas.trinityscience.org/webdav`, request `Host: veritas.trinityscience.org` (public default 443, not internal 4443), and forwarded https; document that any future nonstandard-port URL must match the forwarded Host exactly or remain disabled. Test negative/absent/Unicode/huge lengths, chunked encoding, quota 507, encoded slash/double encoding/traversal/backslash/NUL/absolute/hidden names, symlink substitution, unknown extensions, oversized XML, DTD, malformed XML, `Depth: infinity`, and native unknown verbs.

- [ ] **Step 3: Bind early dispatch narrowly.** Add helpers only inside `webdav.py`: `matches(path)` recognizes `/webdav` and `/webdav/...`; `trusted_transport(handler, config)` implements the exact peer/local/proxy rule from Step 2 before credential parsing; `dispatch(handler, store)` rejects foreign requests, invalid transport, disabled paths (`404`), and non-DAV verb behavior. Existing verbs call it before `_allowed()` only when `matches()` is true. Add `do_HEAD`, `do_PROPFIND`, `do_MKCOL`; do_PUT preserves its existing non-DAV chain unchanged. No native identity is stored in `_identity` or accepted by ordinary routes, and the agent sidecar is never involved. The parser extracts a restricted username segment, requires it to match the Basic credential username exactly, and derives tenant only from that credential row. Explicitly test mismatched URL usernames for every data verb; the mismatch must not select or enumerate either tenant's files.

- [ ] **Step 4: Implement bounded authentication followed by byte/XML responses.** `OPTIONS` explicitly chooses fixed, tenant-independent capability discovery (policy B): after transport checks it returns 204/DAV/Allow both with and without Basic, performs no username/credential/tenant lookup, and cannot reveal whether the URL username exists. Every data method still requires Basic and auth failure returns 401 + `WWW-Authenticate: Basic realm="Veritas Zotero"`. PBKDF2 verification runs inside a four-permit nonblocking semaphore so excess unauthenticated verifier requests return 429 promptly instead of exhausting `ThreadingHTTPServer`; a forced blocked-verifier test proves the fifth request is rejected. `HEAD/GET` streams 64-KiB blocks from the already-open FD; `Content-Type` is `application/zip` for `.zip` and `text/xml` for `.prop`; `ETag` uses the SHA-256 stored at upload and responses are `private, no-store`. 204 has `Content-Length: 0`. Connection/broken-pipe interruption aborts writes cleanly. These helpers stay inside the native dispatcher rather than generalizing ordinary routes.

- [ ] **Step 5: Implement bounded PROPFIND.** Require Depth 0/1 (default 0); read at most 64 KiB using the existing strict Content-Length rule. Reject `<!DOCTYPE` case-insensitively before parsing and use `ElementTree` only for well-formedness. Generate escaped multistatus XML with the canonical request path, `getcontentlength`, `getlastmodified`, `getetag`, and `resourcetype` only for parent/`zotero` collections. Depth 1 uses only `store.list(tenant)` rows sorted by name; no filesystem glob or other-tenant data.

- [ ] **Step 6: Bound authenticated upload lifetime, map protocol errors, and rerun.** Before reserve, each PUT nonblockingly acquires one of four per-tenant upload permits and one of eight global permits; excess requests return 429 before body bytes/reservations. After acquisition, set a 60-second per-read socket timeout (small injected value in tests), restore/cancel it in `finally`, and abort reservation/permits on every exit. An idle-but-authenticated client receives 408 and its reservation releases; active large uploads make steady progress. `DavError` otherwise carries fixed status/message/headers: invalid/missing upload length 411/400, unsupported transfer 501, path 400/404 as pinned, over cap 413, quota 507, inactive disabled 404, existing collection 405. Rejected bodies remain unread with `close_connection=True`; disconnects/timeouts always call `store.abort`. Add permit-exhaustion and idle-timeout tests before running `test_webdav.py`, `test_zotero_storage.py`, `test_zotero_storage_http.py`, `test_http_security.py`, and `test_globus_agent.py`.

### Task 4: Settings panel and documentation

**Files:** `web/src/zotero-storage-view.js`, `web/test/zotero-storage-view.test.js`, `web/src/pages.js`, `ui/src/settings/settings-schema.js`, `ui/test/settings-schema.test.js`, `docs/guide/*.md`, `docs/README.md`, spec 025

- [ ] **Step 1: Write failing UI tests.** Fake hosts model disabled, unissued/issued, usage, issue failure, and revoke. Assert GET on mount, POST issuance only on click, DELETE confirmation, busy controls, safe text-only errors, rounded usage, exact canonical endpoint display, personal-library-only instructions, one-time password output, and removal of that output on the next refresh/account response. Spys prove no localStorage, `/web/state`, or saved hidden input receives the password.

- [ ] **Step 2: Implement `zoteroStorageWidget(doc, host)` with existing `h()` and `host.json()` idioms.** Inputs/buttons have accessible labels; issuance/revocation use explicit click actions, not credentials in GET URLs. A render replaces all sensitive nodes. Disabled status explains that the operator must configure canonical HTTPS; admin/no-session 403/401 remains handled by existing transport. Add the `folders.zoteroStorage` custom row for `WEB`, register `zoteroStorage` in `pages.js`, and preserve all existing folder/source behavior.

- [ ] **Step 3: Run JS gates.** `cd web && npm test && npm run typecheck && npm run build` and `cd ui && node --test test/*.test.js && npm run typecheck` pass. Add the Python source files to `restart_when_code_changes()`.

- [ ] **Step 4: Document the trust model and blocked rollout.** Update architecture/privacy/Globus guide and docs index with this exact scope (metadata stays at Zotero), file layouts/modes, credential model, quotas, last-writer semantics, recovery/single-process assumption, default-disabled config, and one-time UI secrets. Include the live deployment's current nginx `client_max_body_size 45m`, required proxy DAV method/header/body/timeout decisions, disk/backups, real desktop verification and two-client test. No deploy files or running services change.

### Task 5: Self-check, publication, independent review, gate

- [ ] **Step 1: Review the complete diff for unnecessary scope.** Confirm there is no metadata API/index/search/scheduler work and no search/global source modifications. Check all early dispatch branches preserve non-DAV behavior; native request bodies are bounded/streamed; no plaintext secret appears in test snapshots/logs/docs. Inspect `git status`, `git diff`, `git log --oneline -10`, `git diff --check`, and only intended files.

- [ ] **Step 2: Run all tests and area docs.** Run every focused suite followed by complete `./check.sh`; report actual counts/skips. Run `python3 scripts/agent/area_docs_for_diff.py` using its real CLI against the Veritas worktree diff and report results separately. Treat unavailable Trinity/actual-Zotero/proxy gates as unavailable, not passed.

- [ ] **Step 3: Publish when authorized.** Commit only the reviewed implementation/spec/tests/docs, push `veritas-zotero-sync` to `zhenghh04/veritas-ai`, and open a PR to its `main` with a body file carrying the base/dependency, scope/non-goals, exact verification, 50-GiB design, blocked production 45-MiB proxy cap, and real-desktop prerequisite. Do not merge or deploy.

- [ ] **Step 4: Run `independent-review-loop` to its terminal decision.** Keep GPT-6 Sol primary and obtain the required different-model challenge on the identical frozen snapshot. Apply verified in-scope review findings test-first, preserve campaign evidence and cost/stability decisions, then run the available final regression gate and hand off exact head/base/controller/gate/unresolved rollout checks. Human merge remains mandatory.
