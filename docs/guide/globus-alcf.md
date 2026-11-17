# Independent Globus and ALCF authentication

Veritas can offer an independent **Sign in with Globus** option alongside its administrator access-code login. The
flow uses Veritas's own application sessions and directly stored per-user ALCF Inference credentials. It does not use
a Trinity JWT, a `trinf_` credential, or a shared operator ALCF token.

## Register and configure

On the existing **confidential** Globus application, register this exact additional redirect URI without changing any
existing Trinity callbacks:

```text
https://veritas.trinityscience.org/auth/globus/callback
```

Globus selects a redirect only from the app's registered entries. There is no automatic callback fallback: Veritas
always sends its registered callback, and Trinity continues to send its own.

Create `$VERITAS_DATA/globus-auth.json` with mode `0600`:

```json
{
  "client_id": "<existing confidential Globus application client ID>",
  "client_secret": "<existing confidential Globus application client secret>",
  "redirect_uri": "https://veritas.trinityscience.org/auth/globus/callback"
}
```

Restart Veritas after adding or changing this file. Missing or invalid configuration disables the Globus login link but
does not disable the existing access-code login or A2A. `http://127.0.0.1[:port]/auth/globus/callback` is accepted for
loopback development; other HTTP or unregistered callback values are refused. The Python server must remain a single
process: pending OAuth state and its locks are deliberately process-local.

## Flow and assurance

Login requests exactly these scopes:

```text
openid profile email
https://auth.globus.org/scopes/681c10cc-f684-4540-bcd7-0b4df3bc26ef/action_all
```

It requests offline access, `prompt=login`, S256 PKCE, and this ANL Inference session policy:

```text
83732ff2-9c42-4548-b5ce-17e498c84f6a
```

The callback is accepted only for a top-level navigation with a valid, single-use, ten-minute state and a matching
short-lived `vg_login` browser-binding cookie. That cookie is `HttpOnly; SameSite=Lax; Max-Age=600; Path=/auth/globus`;
`Secure` is set for HTTPS. Veritas keeps at most 1,024 pending states and rejects excess attempts until older states
expire or complete.

The server verifies the Globus-signed ID token's signature, client audience, expiry, issuer and required claims, then
compares its nonce and subject to the flow and Globus userinfo response. It also requires an ALCF Inference access and
refresh token. Only then does it issue the independent 12-hour `vg_session` application cookie (`HttpOnly`,
`SameSite=Strict`, `Path=/`, and `Secure` when the configured callback is HTTPS). Auth responses are `no-store`.
Logout revokes the application session and clears its cookie; it does not expose or print stored credentials.

Veritas sends `code_verifier`, client credentials and user profile requests only to Globus. ID/access/refresh tokens are
never placed in URLs, application cookies, browser storage or responses. Callback authorization codes and state are not
written to application logs. A restart invalidates unfinished login attempts; completed application sessions survive
until their absolute expiry.

## Storage and refresh

Sensitive files live outside `data/web`:

| Path | Contents | Mode |
|---|---|---|
|`data/globus-auth.json`|Confidential app configuration|`0600`|
|`data/auth/sessions.json`|Hashed application-session IDs and 12-hour expiries|`0600`|
|`data/users/<sha256-sub>/identity.json`|Minimal verified profile|`0600`|
|`data/users/<sha256-sub>/globus-tokens.json`|That user's ALCF Inference access/refresh token|`0600`|

Parent directories are `0700`; writes use an owner-only temporary file and atomic replacement. Tenant directory names
are SHA-256 keys of the verified subject, never email addresses or raw subjects. The shared Veritas OS service account
can read credentials for all browser tenants; the tenant boundary protects remote users from one another, not mutually
hostile local processes running as that same OS account.

ALCF tokens refresh within five minutes of expiry using the same confidential app, with a 15-second transport timeout
and no SDK retries. Refresh is single-flight per tenant and does not block public routes or another tenant. A Globus app
client-ID change requires a fresh user login instead of refreshing another app's grant. If the process dies after Globus
rotates a refresh token but before Veritas persists it, the old grant may be unusable and the user must log in again;
Veritas fails closed rather than silently substituting an operator token.

## Interactive ALCF workspaces

A `vg_session` selects a per-user interactive agent runtime. The user can use Chat, Quick Answer, interactive sessions,
projects, skills, model settings and provider discovery, plus their own small web preferences. Each runtime has separate
settings, chats, saved searches, provider state and private credentials beneath `data/users/<sha256-sub>/agent/`. Web preferences
use `data/users/<sha256-sub>/web-state.json`. The library/index remains shared read-only; admin data is never
automatically imported into a tenant.

Open **Settings → AI** on first login, choose an ALCF provider/model, and save it for Chat and Quick Answer. Veritas
discovers Sophia, Metis, Minerva and Tara models from the gateway-wide `list-endpoints` catalog and filters each exact
cluster/framework. Catalog visibility does not prove that the user's Globus groups entitle every model; ALCF may still
reject the request. A fallback to a ready OpenAI-compatible provider resolves that catalog's default/first model rather
than sending a null model ID.

The fixed ALCF chat destinations are under `https://inference-api.alcf.anl.gov/resource_server/` using these prefixes:

- `sophia/vllm/v1`
- `metis/api/v1`
- `minerva/api/v1`
- `tara/api/v1`

Successful discovery responses are runtime-local and cached for at most 60 seconds. Discovery uses the user's token and
never falls back to stale data after authorization rejection. Chat, status, model and repair calls fetch refreshed user
credentials through a sidecar-secret-only Python broker, without putting them in the Node environment, shared files,
prompt-prefix caches or settings. Upstream 401/403 causes one forced refresh and retry; simultaneous forced requests in this
tenant share that operation.

ALCF completion streams have a 64 MiB total/per-line byte limit. Line framing processes incoming bytes incrementally;
oversized streams are cancelled with a fixed error instead of exposing upstream content. Early stream termination
also closes the reader.

The access-code/Bearer and A2A credentials remain independent, and each successful login method clears its previous
browser cookie to make account switches explicit. A Globus cookie is not an A2A credential, an administrator API token,
or an alias for another tenant. Existing A2A questions continue to use the legacy runtime, not a browser tenant's
credentials. Tenant runtimes never create Codex/Claude/local CLI providers, never mirror chats into the shared library,
and never write shared notes, skills or digests. Private skills, reports and digests stay beneath the tenant data
directory. Tenant conversations, settings and private web-state answers are `no-store`; protected file answers are also
not cached as shared responses.

**No arbitrary execution or custom endpoints for Globus users.** Tenants cannot save stdio or HTTP MCP servers or custom
OpenAI-compatible endpoints, including on disk before runtime construction. Built-in ALCF choices are the only remote
model providers, so their exact destinations cannot be replaced by `alcf-*` collisions. MCP tool calls use only an
already-active tenant's own library-tool gateway; unauthenticated unknown tenants return 404 without constructing a
runtime or spawning a child. Adoption routes and unsafe object/result/version identifiers are refused before storage access,
and result paths are checked against the runtime directory and session manifest. Tenant-controlled `/agent/radar/check`
address checks are administrator-only, so tenant input cannot turn the shared host into an SSRF client.

Background literature reviews and routines are administrator-only in this slice; tenant `/agent/reviews*` and
`/agent/routines*` requests return 403, and tenant schedulers do not own timer work. Up to 16 interactive runtimes are
loaded at once, counting construction and disposal toward the cap. Pending acquisitions, active requests and detached
interactive columns steps (including final persistence) prevent eviction. Idle runtimes are disposed after 30 minutes
or as idle least-recently-used capacity is needed; disposal rechecks activity before deleting every candidate. Their
persisted state remains on disk and can be opened again. A failed disposal retains its slot until sidecar restart,
because partially disposed resources must not be reused. At capacity with no idle runtime, new tenants receive 503
and can retry after active work finishes.

## Authorization boundary

Globus users also retain the read-only shared-library routes, subject to the same `privacy.json` private-note hiding and
read/search size caps as agent requests. They cannot mutate sources/index, write shared skills, use local-only sign-in
links, select another tenant with a request header or inherit provider settings from the legacy runtime.
Administrator/Bearer and loopback requests keep the existing global runtime and independent access-code session.

Local Zotero PDFs are authorized against their indexed parent in the selected library, not the attachment key.
This also applies to local copies reached through DOI links in the web page/PDF panel. Unknown, unindexed or
unreadable ownership fails closed for restricted callers, even when no items are marked private. Named aliases
of the default library use its unprefixed index paths. Paper-note reads additionally check the resolved vault note
before reading its content. Zotero status responses omit private item keys without changing the shared status cache;
administrator reads and PDF Range support retain their existing behavior. Collection metadata policy is unchanged.

## Checks

After authorized deployment, test both successful Globus sign-in and cancellation in a browser. Confirm that only
`vg_login` is set by login start, `vg_login` is cleared on callback, the resulting Strict session is rejected after
logout, and neither Globus nor ALCF token values appear in URLs, browser storage or server logs. Test a real token
refresh and ALCF authorization failure/success without printing credentials. Unit tests are not a substitute for these
live checks.
