"""Independent Globus sign-in: storage, OIDC verification, and ALCF token lifecycle."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import threading
import time
from pathlib import Path

import pytest

import globus_auth
import user_store
from user_store import UserStore


NOW = 1_800_000_000.0


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "users", tmp_path / "auth" / "sessions.json", now=lambda: NOW)


def profile(subject: str = "subject-A", name: str = "A User") -> dict:
    return {"sub": subject, "name": name, "preferred_username": "a@alcf.anl.gov", "email": "a@example.org"}


def inference(access: str = "access-A", refresh: str = "refresh-A", expires: float = NOW + 3600,
              client_id: str = "client-A") -> dict:
    return {
        "access_token": access,
        "refresh_token": refresh,
        "expires_at": expires,
        "resource_server": globus_auth.INFERENCE_RS,
        "client_id": client_id,
    }


def test_tenant_storage_sessions_and_permissions(store: UserStore, tmp_path: Path):
    tenant = store.tenant_id("subject-A")
    assert tenant == hashlib.sha256(b"subject-A").hexdigest()
    assert tenant != store.tenant_id("subject-B")
    assert len(tenant) == 64 and set(tenant) <= set("0123456789abcdef")

    store.save_profile(tenant, profile())
    store.save_inference(tenant, inference())
    raw = store.create_session(profile(), ttl=globus_auth.SESSION_SECONDS)

    assert store.principal(raw) == {
        "kind": "globus",
        "tenant": tenant,
        "name": "A User",
        "preferred_username": "a@alcf.anl.gov",
    }
    session_file = tmp_path / "auth" / "sessions.json"
    assert raw not in session_file.read_text()
    assert hashlib.sha256(raw.encode()).hexdigest() in session_file.read_text()
    assert store.inference(tenant) == inference()
    assert not (tmp_path / "users" / "subject-A").exists()

    for directory in (tmp_path / "auth", tmp_path / "users", tmp_path / "users" / tenant):
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    for file in (session_file, tmp_path / "users" / tenant / "identity.json",
                 tmp_path / "users" / tenant / "globus-tokens.json"):
        assert stat.S_IMODE(file.stat().st_mode) == 0o600


def test_sessions_expire_revoke_and_survive_restart(store: UserStore, tmp_path: Path):
    raw = store.create_session(profile(), ttl=100)
    reloaded = UserStore(tmp_path / "users", tmp_path / "auth" / "sessions.json", now=lambda: NOW + 99)
    assert reloaded.principal(raw)["tenant"] == store.tenant_id("subject-A")

    reloaded.now = lambda: NOW + 100
    assert reloaded.principal(raw) is None
    reloaded.now = lambda: NOW
    reloaded.revoke_session(raw)
    assert reloaded.principal(raw) is None
    assert store.principal(raw) is not None  # a separate store is intentionally a separate process


def test_storage_rejects_malformed_tenants_and_files(store: UserStore, tmp_path: Path):
    for tenant in ("", "../x", "subject-A", "A" * 64, "f" * 63):
        with pytest.raises(ValueError, match="invalid tenant"):
            store.save_inference(tenant, inference())
    with pytest.raises(ValueError, match="Globus subject"):
        store.tenant_id("")

    tenant = store.tenant_id("subject-A")
    (tmp_path / "users" / tenant).mkdir(parents=True)
    (tmp_path / "users" / tenant / "globus-tokens.json").write_text("not-json")
    assert store.inference(tenant) is None


def test_storage_defaults_replace_existing_files_atomically(store: UserStore, tmp_path: Path):
    tenant = store.tenant_id("subject-A")
    store.save_inference(tenant, inference())
    token_file = tmp_path / "users" / tenant / "globus-tokens.json"
    os.chmod(token_file, 0o644)
    store.save_inference(tenant, inference(access="access-B"))
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert store.inference(tenant)["access_token"] == "access-B"
    assert list(token_file.parent.glob("*.tmp")) == []


class AuthFixture:
    def __init__(self):
        self.clients = []
        self.token_calls = []
        self.refresh_calls = []
        self.userinfo_calls = []
        self.response_nonce = ""
        self.claims = {
            "iss": "https://auth.globus.org",
            "sub": "subject-A",
            "aud": "client-A",
            "nonce": "",
            "exp": NOW + 3600,
            "iat": NOW,
            "name": "A User",
            "preferred_username": "a@alcf.anl.gov",
        }
        self.tokens = {
            "auth.globus.org": {"access_token": "openid-access"},
            globus_auth.INFERENCE_RS: {
                "access_token": "inference-access",
                "refresh_token": "inference-refresh",
                "expires_at_seconds": NOW + 3600,
            },
        }
        self.userinfo = profile()

    def client(self, config):
        fixture = self

        class Flow:
            def __init__(self, client, **kwargs):
                self.client = client
                self.kwargs = kwargs

            def get_authorize_url(self, query_params):
                from urllib.parse import urlencode
                values = {
                    "client_id": config.client_id,
                    "redirect_uri": self.kwargs["redirect_uri"],
                    "scope": " ".join(self.kwargs["requested_scopes"]),
                    "state": self.kwargs["state"],
                    "response_type": "code",
                    "access_type": "offline",
                    **query_params,
                }
                self.query = values
                self.client.flow_query = values
                return "https://auth.globus.org/v2/oauth2/authorize?" + urlencode(values)

        class Response:
            def __init__(self, data):
                self.data = data

            @property
            def by_resource_server(self):
                return fixture.tokens

            def decode_id_token(self):
                claims = dict(fixture.claims)
                if not claims.get("nonce"):
                    claims["nonce"] = fixture.response_nonce
                return claims

        class Client:
            def __init__(self):
                self.client_id = config.client_id
                self.flow = None

            def oauth2_start_flow(self, **kwargs):
                self.flow = Flow(self, **kwargs)
                return self.flow

            def oauth2_token(self, form, response_class):
                fixture.response_nonce = self.flow_query["nonce"]
                fixture.token_calls.append(form)
                return Response({})

            def get_openid_configuration(self):
                return Response({"issuer": "https://auth.globus.org"})

            def get(self, path, headers, automatic_authorization=True):
                assert automatic_authorization is False
                fixture.userinfo_calls.append((path, headers))
                return Response(fixture.userinfo)

            def oauth2_refresh_token(self, refresh_token):
                fixture.refresh_calls.append(refresh_token)
                return Response({})

        client = Client()
        self.clients.append(client)
        return client


def config() -> globus_auth.Config:
    return globus_auth.Config(
        client_id="client-A",
        client_secret="test-client-secret",
        redirect_uri="https://veritas.trinityscience.org/auth/globus/callback",
    )


def manager(store: UserStore, fixture: AuthFixture):
    auth = globus_auth.GlobusAuth(config(), store, client_factory=fixture.client, now=lambda: NOW)
    fixture.owner = auth
    return auth


def start(auth: globus_auth.GlobusAuth):
    from urllib.parse import parse_qs, urlsplit
    url, binding = auth.start()
    query = parse_qs(urlsplit(url).query)
    return url, binding, query


def complete(auth: globus_auth.GlobusAuth, binding: str, state: str, **kwargs):
    return auth.complete(state=state, code="authorization-code", binding=binding, **kwargs)


def test_config_requires_exact_registered_callback_or_loopback(tmp_path: Path):
    good = tmp_path / "globus-auth.json"
    good.write_text(json.dumps({
        "client_id": "client-A", "client_secret": "private",
        "redirect_uri": "https://veritas.trinityscience.org/auth/globus/callback",
    }))
    assert globus_auth.Config.load(good).secure_cookie is True
    assert stat.S_IMODE(good.stat().st_mode) == 0o600

    loopback = config().__dict__ | {"redirect_uri": "http://127.0.0.1:27182/auth/globus/callback"}
    good.write_text(json.dumps(loopback))
    assert globus_auth.Config.load(good).secure_cookie is False

    invalid_values = [
        {},
        {"client_id": "client-A", "client_secret": "", "redirect_uri": config().redirect_uri},
        config().__dict__ | {"redirect_uri": "http://veritas.trinityscience.org/auth/globus/callback"},
        config().__dict__ | {"redirect_uri": "https://evil.example/auth/globus/callback"},
        config().__dict__ | {"redirect_uri": "https://veritas.trinityscience.org/other"},
        config().__dict__ | {"redirect_uri": "http://localhost:27182/auth/globus/callback"},
    ]
    for value in invalid_values:
        good.write_text(json.dumps(value))
        with pytest.raises(globus_auth.AuthError, match="invalid Globus configuration") as error:
            globus_auth.Config.load(good)
        assert error.value.status == 503
        assert "private" not in str(error.value)
    good.write_text("not json")
    with pytest.raises(globus_auth.AuthError, match="invalid Globus configuration"):
        globus_auth.Config.load(good)
    good.unlink()
    with pytest.raises(globus_auth.AuthError, match="invalid Globus configuration"):
        globus_auth.Config.load(good)


def test_login_uses_alcf_scope_policy_pkce_nonce_and_browser_binding(store: UserStore):
    fixture = AuthFixture()
    auth = manager(store, fixture)
    url, binding, query = start(auth)

    for key in ("code_challenge", "code_challenge_method", "state", "nonce", "prompt",
                "session_required_policies", "redirect_uri", "response_type", "access_type", "scope", "client_id"):
        assert len(query[key]) == 1, key
    assert query["scope"][0].split(" ") == ["openid", "profile", "email", globus_auth.INFERENCE_SCOPE]
    assert query["session_required_policies"] == [globus_auth.ANL_POLICY]
    assert query["prompt"] == ["login"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"] == [config().redirect_uri]
    assert query["access_type"] == ["offline"]
    assert query["client_id"] == ["client-A"]
    assert binding not in url
    pending = auth.pending[query["state"][0]]
    assert pending.binding_hash == hashlib.sha256(binding.encode()).digest()
    assert pending.nonce == query["nonce"][0]
    challenge = query["code_challenge"][0]
    import base64
    assert challenge == base64.urlsafe_b64encode(hashlib.sha256(pending.verifier.encode()).digest()).rstrip(b"=").decode()

    session = complete(auth, binding, query["state"][0])
    exchange = fixture.token_calls[0]
    assert exchange == {
        "grant_type": "authorization_code",
        "code": "authorization-code",
        "redirect_uri": config().redirect_uri,
        "code_verifier": pending.verifier,
    }
    assert fixture.userinfo_calls[0][1] == {"Authorization": "Bearer openid-access"}
    assert store.principal(session)["tenant"] == store.tenant_id("subject-A")
    stored = store.inference(store.tenant_id("subject-A"))
    assert stored["access_token"] == "inference-access"
    assert stored["client_id"] == "client-A"
    assert session not in (stored["access_token"], stored["refresh_token"])


def test_callback_rejects_missing_binding_provider_errors_and_replay(store: UserStore):
    fixture = AuthFixture()
    auth = manager(store, fixture)
    _, binding, query = start(auth)
    state = query["state"][0]

    with pytest.raises(globus_auth.AuthError, match="browser binding"):
        complete(auth, "wrong-binding", state)
    assert fixture.token_calls == []
    assert state not in auth.pending

    _, binding, query = start(auth)
    with pytest.raises(globus_auth.AuthError, match="denied"):
        complete(auth, binding, query["state"][0], provider_error="access_denied")
    assert query["state"][0] not in auth.pending
    assert fixture.token_calls == []

    _, binding, query = start(auth)
    complete(auth, binding, query["state"][0])
    with pytest.raises(globus_auth.AuthError, match="login state"):
        complete(auth, binding, query["state"][0])
    assert len(fixture.token_calls) == 1


def test_callback_rejects_expired_state_missing_code_and_caps_pending(store: UserStore, monkeypatch):
    clock = [NOW]
    fixture = AuthFixture()
    auth = globus_auth.GlobusAuth(config(), store, client_factory=fixture.client, now=lambda: clock[0])
    fixture.owner = auth
    _, binding, query = start(auth)
    clock[0] += globus_auth.STATE_TTL + 1
    with pytest.raises(globus_auth.AuthError, match="login state"):
        complete(auth, binding, query["state"][0])
    assert fixture.token_calls == []

    _, binding, query = start(auth)
    with pytest.raises(globus_auth.AuthError, match="authorization code"):
        auth.complete(state=query["state"][0], code="", binding=binding)

    monkeypatch.setattr(globus_auth, "STATE_CAP", 1)
    start(auth)
    with pytest.raises(globus_auth.AuthError, match="too many") as error:
        start(auth)
    assert error.value.status == 429
    assert len(auth.pending) == 1
    clock[0] += globus_auth.STATE_TTL + 1
    start(auth)
    assert len(auth.pending) == 1


def test_double_callback_has_one_winner(store: UserStore):
    fixture = AuthFixture()
    auth = manager(store, fixture)
    _, binding, query = start(auth)
    results = []
    barrier = threading.Barrier(3)

    def run():
        barrier.wait()
        try:
            results.append(complete(auth, binding, query["state"][0]))
        except globus_auth.AuthError as error:
            results.append(error)

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()
    assert sum(isinstance(value, str) for value in results) == 1
    assert sum(isinstance(value, globus_auth.AuthError) for value in results) == 1


@pytest.mark.parametrize("change", [
    {"nonce": "wrong"},
    {"iss": "https://evil.example"},
    {"sub": ""},
    {"exp": 0},
    {"iat": 0},
    {"aud": ""},
])
def test_callback_rejects_invalid_id_claims(store: UserStore, change):
    fixture = AuthFixture()
    auth = manager(store, fixture)
    _, binding, query = start(auth)
    fixture.claims.update(change)
    with pytest.raises(globus_auth.AuthError, match="identity validation"):
        complete(auth, binding, query["state"][0])
    assert not (store.root / store.tenant_id("subject-A") / "globus-tokens.json").exists()


@pytest.mark.parametrize("problem", ["subject", "openid", "inference", "refresh"])
def test_callback_requires_matching_userinfo_and_inference_credentials(store: UserStore, problem):
    fixture = AuthFixture()
    auth = manager(store, fixture)
    _, binding, query = start(auth)
    if problem == "subject":
        fixture.userinfo["sub"] = "subject-B"
    elif problem == "openid":
        fixture.tokens.pop("auth.globus.org")
    elif problem == "inference":
        fixture.tokens.pop(globus_auth.INFERENCE_RS)
    else:
        fixture.tokens[globus_auth.INFERENCE_RS].pop("refresh_token")
    with pytest.raises(globus_auth.AuthError):
        complete(auth, binding, query["state"][0])
    assert not store.sessions_file.exists()
    assert list(store.root.rglob("globus-tokens.json")) == []
    assert list(store.root.rglob("identity.json")) == []


def test_real_sdk_decoder_rejects_wrong_keys_audience_and_expiry():
    from types import SimpleNamespace
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
    from globus_sdk.services.auth.id_token_decoder import IDTokenDecoder

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    client = SimpleNamespace(client_id="client-A")
    decoder = IDTokenDecoder(client)
    decoder.store_openid_configuration({
        "issuer": "https://auth.globus.org",
        "id_token_signing_alg_values_supported": ["RS512"],
    })
    decoder.store_jwk(private.public_key())
    issued = int(time.time())
    claims = {"iss": "https://auth.globus.org", "sub": "subject-A", "aud": "client-A",
              "nonce": "nonce", "iat": issued - 10, "exp": issued + 1000}

    valid = jwt.encode(claims, private, algorithm="RS512")
    assert decoder.decode(valid)["sub"] == "subject-A"
    wrong_key = jwt.encode(claims, other, algorithm="RS512")
    with pytest.raises(jwt.InvalidTokenError):
        decoder.decode(wrong_key)
    with pytest.raises(jwt.InvalidTokenError):
        decoder.decode(jwt.encode(claims | {"aud": "other-client"}, private, algorithm="RS512"))
    with pytest.raises(jwt.InvalidTokenError):
        decoder.decode(jwt.encode(claims | {"exp": issued - 1000}, private, algorithm="RS512"))
    unsigned = jwt.encode(claims, None, algorithm="none")
    with pytest.raises(jwt.InvalidTokenError):
        decoder.decode(unsigned)


def prepare_refresh(store: UserStore, fixture: AuthFixture, tenant: str, **changes):
    auth = manager(store, fixture)
    token = inference(expires=NOW + 100) | changes
    store.save_profile(tenant, profile(store_tenant_subject(tenant)))
    store.save_inference(tenant, token)
    fixture.tokens = {
        globus_auth.INFERENCE_RS: {
            "access_token": "new-access",
            "refresh_token": "rotated-refresh",
            "expires_at_seconds": NOW + 3600,
        },
    }
    return auth, token


def store_tenant_subject(tenant: str) -> str:
    return "subject-A" if tenant == UserStore.tenant_id("subject-A") else "subject-B"


def test_valid_inference_token_does_not_refresh_and_status_is_safe(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    store.save_inference(tenant, inference())
    auth = manager(store, fixture)
    assert auth.inference_access_token(tenant) == "access-A"
    assert fixture.refresh_calls == []
    assert auth.inference_status(tenant) == {"connected": True, "needs_reauth": False, "expires_at": NOW + 3600}
    assert "access-A" not in json.dumps(auth.inference_status(tenant))


def test_near_expiry_refresh_rotates_and_persists_credentials(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, _ = prepare_refresh(store, fixture, tenant)
    assert auth.inference_access_token(tenant) == "new-access"
    assert fixture.refresh_calls == ["refresh-A"]
    stored = store.inference(tenant)
    assert stored == {
        "access_token": "new-access",
        "refresh_token": "rotated-refresh",
        "resource_server": globus_auth.INFERENCE_RS,
        "client_id": "client-A",
        "expires_at": NOW + 3600,
    }


def test_refresh_preserves_old_refresh_token_only_when_replacement_is_omitted(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, _ = prepare_refresh(store, fixture, tenant)
    fixture.tokens[globus_auth.INFERENCE_RS].pop("refresh_token")
    assert auth.inference_access_token(tenant) == "new-access"
    assert store.inference(tenant)["refresh_token"] == "refresh-A"


def test_refresh_rejects_wrong_resource_and_client_rotation(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, previous = prepare_refresh(store, fixture, tenant)
    fixture.tokens = {"other.example": {"access_token": "wrong", "expires_at_seconds": NOW + 4000}}
    with pytest.raises(globus_auth.AuthError) as error:
        auth.inference_access_token(tenant)
    assert error.value.status == 502
    assert store.inference(tenant) == previous
    assert "refresh-A" not in str(error.value)

    store.save_inference(tenant, inference(client_id="retired-client", expires=NOW + 100))
    calls = len(fixture.refresh_calls)
    with pytest.raises(globus_auth.AuthError) as error:
        auth.inference_access_token(tenant)
    assert error.value.status == 401
    assert len(fixture.refresh_calls) == calls
    assert auth.inference_status(tenant) == {"connected": False, "needs_reauth": True, "expires_at": None}


def test_concurrent_refresh_runs_once_per_tenant(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, _ = prepare_refresh(store, fixture, tenant)
    original_factory = fixture.client

    def slow_factory(config):
        client = original_factory(config)
        refresh = client.oauth2_refresh_token

        def delayed(refresh_token):
            time.sleep(0.05)
            return refresh(refresh_token)

        client.oauth2_refresh_token = delayed
        return client

    auth.client_factory = slow_factory
    barrier = threading.Barrier(9)
    results = []

    def run():
        barrier.wait()
        results.append(auth.inference_access_token(tenant))

    threads = [threading.Thread(target=run) for _ in range(8)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()
    assert results == ["new-access"] * 8
    assert len(fixture.refresh_calls) == 1


def test_parallel_forced_refreshes_reuse_the_first_rotated_token(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, _ = prepare_refresh(store, fixture, tenant)
    original_factory = fixture.client

    def slow_factory(config):
        client = original_factory(config)
        refresh = client.oauth2_refresh_token

        def delayed(refresh_token):
            time.sleep(0.05)
            return refresh(refresh_token)

        client.oauth2_refresh_token = delayed
        return client

    auth.client_factory = slow_factory
    barrier = threading.Barrier(3)
    results = []

    def run():
        barrier.wait()
        results.append(auth.inference_access_token(tenant, force=True))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()
    assert results == ["new-access", "new-access"]
    assert len(fixture.refresh_calls) == 1


def test_one_tenant_refresh_does_not_block_another(store: UserStore):
    fixture = AuthFixture()
    tenant_a, tenant_b = store.tenant_id("subject-A"), store.tenant_id("subject-B")
    auth, _ = prepare_refresh(store, fixture, tenant_a)
    store.save_profile(tenant_b, profile("subject-B", "B User"))
    store.save_inference(tenant_b, inference(access="access-B", refresh="refresh-B", expires=NOW + 100))
    entered, release = threading.Event(), threading.Event()
    original_factory = fixture.client

    def blocking_factory(config):
        client = original_factory(config)
        client_id = len(fixture.clients)
        refresh = client.oauth2_refresh_token
        if client_id == 1:
            def blocked(refresh_token):
                entered.set()
                assert release.wait(2)
                return refresh(refresh_token)
            client.oauth2_refresh_token = blocked
        return client

    auth.client_factory = blocking_factory
    results = []
    first = threading.Thread(target=lambda: results.append(auth.inference_access_token(tenant_a)))
    first.start()
    assert entered.wait(1)
    assert auth.inference_access_token(tenant_b) == "new-access"
    assert store.principal(store.create_session(profile("subject-B"), 100))["tenant"] == tenant_b
    release.set()
    first.join(2)
    assert not first.is_alive() and results == ["new-access"]


@pytest.mark.parametrize("bad_expiry", [NOW - 1, float("nan"), float("inf"), float("-inf"), True])
def test_refresh_rejects_expired_or_nonfinite_replacement(store: UserStore, bad_expiry):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, previous = prepare_refresh(store, fixture, tenant)
    fixture.tokens[globus_auth.INFERENCE_RS]["expires_at_seconds"] = bad_expiry
    with pytest.raises(globus_auth.AuthError) as error:
        auth.inference_access_token(tenant)
    assert error.value.status == 502
    assert store.inference(tenant) == previous


def test_storage_rejects_nonfinite_and_boolean_expiry(store: UserStore):
    import math
    for value in (float("nan"), float("inf"), float("-inf"), True):
        with pytest.raises(ValueError, match="expiry"):
            store.save_inference(store.tenant_id("subject-A"), inference(expires=value))
    tenant = store.tenant_id("subject-A")
    store.save_inference(tenant, inference())
    token_file = store.root / tenant / "globus-tokens.json"
    token_file.write_text(token_file.read_text().replace(str(NOW + 3600), "NaN"))
    assert store.inference(tenant) is None


def test_invalid_grant_requires_reauth_and_new_login_can_restore_status(store: UserStore):
    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, _ = prepare_refresh(store, fixture, tenant)
    client = auth.client_factory(config())
    import globus_sdk
    import requests
    upstream = requests.Response()
    upstream.status_code = 400
    upstream.headers["Content-Type"] = "application/json"
    upstream._content = b'{"error":"invalid_grant"}'
    upstream.request = requests.Request("POST", "https://auth.globus.org/v2/oauth2/token").prepare()

    def rejected(_refresh):
        raise globus_sdk.GlobusAPIError(upstream)

    original_refresh = client.oauth2_refresh_token
    client.oauth2_refresh_token = rejected
    auth.client_factory = lambda _: client
    with pytest.raises(globus_auth.AuthError) as error:
        auth.inference_access_token(tenant)
    assert error.value.status == 401
    assert auth.inference_status(tenant) == {"connected": False, "needs_reauth": True, "expires_at": None}
    client.oauth2_refresh_token = original_refresh
    assert auth.inference_access_token(tenant, force=True) == "new-access"
    assert auth.inference_status(tenant) == {"connected": True, "needs_reauth": False, "expires_at": NOW + 3600}


def test_real_transport_has_bounded_timeout_and_no_retries(store: UserStore, monkeypatch):
    client = globus_auth._default_client(config())
    assert client.transport.http_timeout == globus_auth.HTTP_TIMEOUT == 15
    assert client.retry_config.max_retries == 0

    fixture = AuthFixture()
    tenant = store.tenant_id("subject-A")
    auth, _ = prepare_refresh(store, fixture, tenant)
    auth.client_factory = lambda _: client
    import requests

    def timeout(*args, **kwargs):
        raise requests.Timeout("test timeout without provider details")

    monkeypatch.setattr(client.transport.session, "request", timeout)
    with pytest.raises(globus_auth.AuthError) as error:
        auth.inference_access_token(tenant)
    assert error.value.status == 502
    assert str(error.value) == "ALCF Inference refresh failed"
