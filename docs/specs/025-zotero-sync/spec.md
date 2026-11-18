# 025: Hosted Zotero WebDAV attachment sync

## Goal and sequence

Let each independently signed-in Globus user configure desktop Zotero's native WebDAV integration to store
personal-library attachments on Veritas, with independently issued credentials and enforced global/per-user storage
quotas. Zotero metadata continues to synchronize through `zotero.org`; desktop Zotero already provides that part of
native synchronization.

This is the first independently usable slice of the larger Zotero synchronization work. Tenant-owned Zotero Web API
credentials, delta metadata synchronization, and personal search indexes are the next slice, not hidden partial work
in this one. Remote Obsidian vaults, group-library attachment files, a replacement Zotero data server, Veritas-side
metadata write-back, and personal PDF reading are also outside this PR.

## Enablement and authorization

- The feature is default-disabled. An operator must configure `VERITAS_WEBDAV_PUBLIC_URL` as an absolute canonical
  HTTPS parent URL ending in `/webdav`, with no user information, query, or fragment. A missing or invalid setting
  makes authenticated management GET return `{enabled:false}`, issuance/revocation return 503, and native DAV paths
  return 404 without opening or exposing stored data. A valid setting whose store cannot be opened at startup
  disables only WebDAV with the same responses, and management GET adds `error: "Zotero file storage is unavailable"`.
- The canonical endpoint never comes from `Host`, `Forwarded`, `X-Forwarded-*`, or request-body input. Native HTTP is
  accepted only when the immediate peer is loopback, as the existing server binds solely to `127.0.0.1`. Direct local
  development may use the loopback development exception. Any proxied request must carry exactly
  `X-Forwarded-Proto: https` and the configured canonical Host; insecure, direct non-loopback, untrusted-peer, wrong-
  Host, or missing-scheme requests are refused before reading Basic credentials. The trusted HTTPS edge is the actual
  configured proxy, which must overwrite forwarding headers.
- Only a verified Globus browser principal can inspect its own status, issue/rotate/revoke credentials, or see its own
  usage. There is no separate tenant-entitlement registry in the current server: enablement is deployment-wide and a
  valid Globus session is the capability. Missing/expired Globus sessions, administrator Bearer/cookie identities,
  A2A tokens, and inbound tenant headers are not alternatives.
- WebDAV Basic credentials are independent random username/password pairs. Only a PBKDF2-HMAC-SHA256 verifier is
  persisted. The password is returned once at issuance and accepted only in the exact `/webdav/` namespace.
- A native request authenticates its URL username and Basic username/password to one tenant record and requires the
  two usernames to match exactly. Loopback is not an authentication bypass. Foreign-browser requests are rejected
  before native authentication. Rotation/revocation blocks new authentications but does not cancel an already
  authenticated bounded upload/download. PBKDF2 work is concurrency-limited; PUT has per-tenant/global permits and a
  60-second idle-read timeout that aborts and releases its reservation.

## Native protocol

Follow the personal-library behavior of Zotero's current `Zotero.Sync.Storage.Mode.WebDAV` client. The displayed
parent URL includes a random username path component; desktop Zotero appends `zotero/` and performs these operations:

- `OPTIONS` advertises `DAV: 1, 2` and the supported methods without revealing tenant data. Other data methods require
  Basic authentication.
- Existing parent and `zotero/` collections return `207 Multi-Status` for `PROPFIND` with `Depth: 0`; `Depth: 1`
  lists only the authenticated tenant's tracked resources. `Depth: infinity` is refused. XML request bodies are at
  most 64 KiB and DTDs are refused.
- `GET`/`HEAD`, streamed `PUT`, `DELETE`, and `MKCOL` support Zotero verification and its `<KEY>.zip`, `<KEY>.prop`,
  `nonexistent.prop` and `zotero-test-file.prop` resources. `lastsync` markers are not implemented because the
  targeted client source only optionally excludes them during orphan listing, not a required write/read operation.
  Creation returns 201, replacement 204,
  missing resources 404, and successful deletion 204.
- Resource names cannot contain separators, encoded separators, traversal, backslashes, NUL, absolute paths, or
  leading dots. Unknown resource types do not create files. SDES path containment is not sufficient: descriptor-based
  no-follow opens and owner-only parent directories protect actual blob reads/installations.
- Uploads require a strict nonnegative decimal `Content-Length`; chunked/other transfer encodings are refused. Actual
  bytes are counted while streaming. Short bodies, disconnects, malformed lengths, and quota refusal never publish a
  partial file.
- Downloads set `Content-Length`, `Content-Type`, `ETag`, and `Cache-Control: private, no-store`; `HEAD` returns the
  same metadata with no body. No ordinary browser, agent, static, or shared-library route serves hosted blobs.

## Durable storage and quotas

- Authoritative blobs live outside the public `data/web` tree under
  `data/users/<tenant>/zotero-storage/{uploads,objects}`. A mode-`0600` SQLite ledger records credentials, active
  file versions, upload reservations, and superseded blobs awaiting deletion. Tenant directories are mode `0700`.
  Every tenant-relative ancestor is created/opened with directory-descriptor-relative, no-follow operations;
  symlinks and unexpected file types fail closed. An exclusive process-lifetime `flock` prevents recovery by a second
  service instance, SQLite uses short per-operation thread-bound connections on a local WAL-capable filesystem, and
  startup recovery runs only after that lock is acquired.
- The default pool is exactly **50 GiB** (`50 * 1024**3` bytes). Each user has an independently accounted **5 GiB**
  default quota. `VERITAS_ZOTERO_STORAGE_BYTES` and `VERITAS_ZOTERO_USER_QUOTA_BYTES` override these deployment
  defaults. Missing values use the defaults; zero, negative, non-integer, boolean-like, excessively long, or above-
  SQLite-signed-integer values fail configuration instead of becoming unlimited. Usage sums are range-checked.
- Each tenant has at most 10,000 distinct active/pending attachment names, including zero-byte files, so metadata
  and PROPFIND responses are bounded. Replacing an existing name remains possible at that limit.
- Quota usage includes active bytes, every temporary/reserved upload, and superseded blobs awaiting unlink. A
  replacement therefore needs old + new bytes while uploading. Over-limit requests return
  `507 Insufficient Storage` before reading the body and close the connection.
- Reservations and active-file changes use `BEGIN IMMEDIATE` in one ledger. Same-name concurrent writes/deletes have
  last committed-writer-wins semantics. Short in-memory open claims mark object IDs pending open and defer garbage;
  generated-ID retiring/claim updates involve no DB/filesystem/socket I/O while locked. The read query and no-follow
  open happen outside that coordination lock. Once opened, a download descriptor retains the selected immutable
  version even if deferred garbage unlinks it, and cannot be redirected cross-tenant.
- Recovery covers every crash point:
  1. After reservation/temp creation, the reservation and both possible new-object locations are still tracked.
  2. After `fsync` and rename but before publication, the old active row remains authoritative; recovery removes the
     uncommitted new object and reservation. An object ID is allocated at reservation time so neither crash location
     can become orphaned or untracked.
  3. Publication commits the new active row, moves the old object to garbage, and deletes the reservation in one
     transaction. Only then can the new bytes be served. No old blob is unlinked inside that transaction.
  4. After publication commits, old bytes are unlinked and their garbage row removed in a second transaction. DELETE
     likewise commits active-removal + garbage insertion before unlink. Old bytes remain counted throughout;
     recovery reconciles garbage files/rows. Every collector checks retirement/open claims before unlink. Cleanup
     failure after a committed publication is retryable and cannot turn the successful upload into failure.
     Missing or size-mismatched active files fail closed instead of silently resetting usage.
- SQLite uses full synchronous commits. Object-directory and rename changes are `fsync`ed before publication. Startup
  recovery assumes the existing single-Python-process service model; concurrent service instances against one ledger
  are not supported.

## Browser settings

**Settings → Folders → Zotero file sync** shows enablement, canonical parent endpoint, per-user usage/quota and the
fixed pool capacity (not other tenants' aggregate activity), issuance, rotation, revocation, and one-time credential
instructions. It does not connect Zotero metadata or display saved API
keys. Responses and errors never put the password in subsequent status, application preferences, agent settings,
browser storage, or server logs. UI text explicitly says personal-library attachments only.

## Deployment gate and acceptance checks

The current production nginx configuration allows only 45 MiB request bodies. Before enabling this feature,
operators must deliberately choose proxy request-size/buffering/timeout behavior, update the canonical HTTPS proxy to
forward all DAV methods and headers, verify available disk/backup policy, then configure the public URL.

Tests must prove:

- Disabled/missing/invalid configuration, expired/absent Globus sessions, administrator/A2A credentials, and hostile
  host/forwarded headers cannot enable issuance or select another tenant.
-   Native Basic credential issuance, rotation, revocation, hash-only persistence, bounded concurrent verifier work,
  and two-tenant isolation.
- The current Zotero verification sequence and normal `.zip`/`.prop` upload/download/list/delete behavior.
- Malformed HTTP auth/body/XML/path cases, cross-site refusal, exact/one-byte-over per-user and global quotas,
  concurrent reservations/replacements/deletes, and downloads concurrent with replacement.
- Crash after reserve, temp write, rename, publication, and old-object unlink stages; no partial new file becomes
  visible and every remaining physical byte is either tracked or recovered as garbage.
- Permission modes and absence of plaintext passwords in storage/responses/logs.
- Existing HTTP/security suites and full native `check.sh` still pass.

A recorded real desktop Zotero verification and two-client upload/download test through the intended proxy is
required before tenant rollout. Unit tests and this PR alone do not establish that deployment prerequisite.
