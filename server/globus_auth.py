"""Independent Globus authentication for Veritas.

The browser receives only Veritas-owned opaque sessions. Globus credentials are
kept server-side, partitioned by verified subject, and refreshed with the same
confidential application that issued them.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import math
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import globus_sdk
from globus_sdk.services.auth.response import OAuthAuthorizationCodeResponse
from globus_sdk.transport import RequestsTransport, RetryConfig

from user_store import UserStore

INFERENCE_RS = "681c10cc-f684-4540-bcd7-0b4df3bc26ef"
INFERENCE_SCOPE = f"https://auth.globus.org/scopes/{INFERENCE_RS}/action_all"
ANL_POLICY = "83732ff2-9c42-4548-b5ce-17e498c84f6a"
CALLBACK_PATH = "/auth/globus/callback"
PRODUCTION_CALLBACK = "https://veritas.trinityscience.org/auth/globus/callback"
LOGIN_SCOPES = ("openid", "profile", "email", INFERENCE_SCOPE)
ISSUER = "https://auth.globus.org"
SESSION_SECONDS = 12 * 3600
STATE_TTL = 600
STATE_CAP = 1024
HTTP_TIMEOUT = 15
REFRESH_LEAD = 300

# globus-sdk 4.9 logs complete ID tokens at DEBUG on this logger. Credentials
# must stay out of logs even if the host application enables DEBUG globally.
logging.getLogger("globus_sdk.services.auth.response.oauth").setLevel(logging.INFO)


class AuthError(Exception):
    """A fixed, credential-free error suitable for an HTTP response."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Config:
    client_id: str
    client_secret: str
    redirect_uri: str

    @property
    def secure_cookie(self) -> bool:
        return urlsplit(self.redirect_uri).scheme == "https"

    @classmethod
    def load(cls, path: Path) -> "Config":
        try:
            value = json.loads(Path(path).read_text())
            if not isinstance(value, dict):
                raise ValueError
            config = cls(**{name: value.get(name) for name in ("client_id", "client_secret", "redirect_uri")})
            if any(not isinstance(field, str) or not field.strip() or field != field.strip()
                   for field in (config.client_id, config.client_secret, config.redirect_uri)):
                raise ValueError
            parsed = urlsplit(config.redirect_uri)
            loopback = (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                        and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
                        and parsed.path == CALLBACK_PATH)
            if config.redirect_uri != PRODUCTION_CALLBACK and not loopback:
                raise ValueError
            path.chmod(0o600)
            return config
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            raise AuthError(503, "invalid Globus configuration") from None


@dataclass
class PendingLogin:
    client: object
    verifier: str
    nonce: str
    binding_hash: bytes
    expires: float


def _default_client(config: Config):
    return globus_sdk.ConfidentialAppAuthClient(
        config.client_id,
        config.client_secret,
        transport=RequestsTransport(http_timeout=HTTP_TIMEOUT),
        retry_config=RetryConfig(max_retries=0),
    )


def _expiry(resource: dict) -> float | None:
    value = resource.get("expires_at_seconds", resource.get("expires_at"))
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


class GlobusAuth:
    def __init__(self, config: Config, store: UserStore, client_factory=_default_client, now=time.time):
        self.config = config
        self.store = store
        self.client_factory = client_factory
        self.now = now
        self.pending: dict[str, PendingLogin] = {}
        self._state_lock = threading.Lock()
        self._refresh_guard = threading.Lock()
        self._refresh_locks: dict[str, threading.Lock] = {}
        self._reauth_required: set[str] = set()

    def start(self) -> tuple[str, str]:
        current = float(self.now())
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(64)
        binding = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        with self._state_lock:
            self.pending = {key: value for key, value in self.pending.items() if value.expires > current}
            if len(self.pending) >= STATE_CAP:
                raise AuthError(429, "too many Globus logins in progress")
            client = self.client_factory(self.config)
            flow = client.oauth2_start_flow(
                redirect_uri=self.config.redirect_uri,
                requested_scopes=LOGIN_SCOPES,
                state=state,
                refresh_tokens=True,
            )
            url = flow.get_authorize_url(query_params={
                "nonce": nonce,
                "session_required_policies": ANL_POLICY,
                "prompt": "login",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            })
            self.pending[state] = PendingLogin(
                client=client,
                verifier=verifier,
                nonce=nonce,
                binding_hash=hashlib.sha256(binding.encode()).digest(),
                expires=current + STATE_TTL,
            )
        return url, binding

    def complete(self, state: str, code: str, binding: str, provider_error: str = "") -> str:
        with self._state_lock:
            pending = self.pending.pop(state, None) if isinstance(state, str) else None
        if not pending or pending.expires <= float(self.now()):
            raise AuthError(400, "invalid or expired Globus login state")
        supplied = hashlib.sha256(binding.encode()).digest() if isinstance(binding, str) else b""
        if not hmac.compare_digest(supplied, pending.binding_hash):
            raise AuthError(400, "invalid Globus browser binding")
        if provider_error:
            raise AuthError(400, "Globus authorization was denied")
        if not isinstance(code, str) or not code:
            raise AuthError(400, "missing Globus authorization code")
        try:
            response = pending.client.oauth2_token({
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.config.redirect_uri,
                "code_verifier": pending.verifier,
            }, response_class=OAuthAuthorizationCodeResponse)
            claims = response.decode_id_token()
            discovery = pending.client.get_openid_configuration().data
        except Exception:
            raise AuthError(502, "Globus token exchange or identity validation failed") from None
        required = ("sub", "exp", "iat", "aud", "nonce")
        nonce = claims.get("nonce")
        if (not isinstance(discovery, dict) or discovery.get("issuer") != ISSUER
                or claims.get("iss") != ISSUER or any(not claims.get(name) for name in required)
                or not isinstance(nonce, str)
                or not isinstance(claims.get("exp"), (int, float))
                or not isinstance(claims.get("iat"), (int, float))
                or not hmac.compare_digest(nonce, pending.nonce)):
            raise AuthError(400, "Globus identity validation failed")
        resources = response.by_resource_server
        auth_resource = resources.get("auth.globus.org") or {}
        openid_token = auth_resource.get("access_token")
        if not isinstance(openid_token, str) or not openid_token:
            raise AuthError(400, "Globus identity validation failed")
        try:
            userinfo = pending.client.get(
                "/v2/oauth2/userinfo",
                headers={"Authorization": f"Bearer {openid_token}"},
                automatic_authorization=False,
            ).data
        except Exception:
            raise AuthError(502, "Globus userinfo request failed") from None
        subject = userinfo.get("sub") if isinstance(userinfo, dict) else None
        if (not isinstance(subject, str) or not subject or not isinstance(claims["sub"], str)
                or not hmac.compare_digest(subject, claims["sub"])):
            raise AuthError(400, "Globus identity validation failed")
        profile = {
            "sub": subject,
            "name": str(userinfo.get("name") or claims.get("name") or ""),
            "preferred_username": str(userinfo.get("preferred_username") or claims.get("preferred_username") or ""),
            "email": str(userinfo.get("email") or claims.get("email") or ""),
        }
        resource = resources.get(INFERENCE_RS) or {}
        access = resource.get("access_token")
        refresh = resource.get("refresh_token")
        expires = _expiry(resource)
        if not all(isinstance(value, str) and value for value in (access, refresh)) or expires is None or expires <= float(self.now()):
            raise AuthError(403, "ALCF Inference authorization is required")
        tenant = self.store.tenant_id(subject)
        # A refresh already in flight finishes before the fresh login replaces
        # its credential; it can never overwrite a newer reauthentication.
        with self._refresh_lock(tenant):
            self.store.save_profile(tenant, profile)
            self.store.save_inference(tenant, {
                "access_token": access,
                "refresh_token": refresh,
                "resource_server": INFERENCE_RS,
                "client_id": self.config.client_id,
                "expires_at": expires,
            })
            self._reauth_required.discard(tenant)
            return self.store.create_session(profile, SESSION_SECONDS)

    def principal(self, raw_session: str) -> dict | None:
        return self.store.principal(raw_session)

    def logout(self, raw_session: str) -> None:
        self.store.revoke_session(raw_session)

    def _refresh_lock(self, tenant: str) -> threading.Lock:
        with self._refresh_guard:
            return self._refresh_locks.setdefault(tenant, threading.Lock())

    @staticmethod
    def _reauth() -> "AuthError":
        return AuthError(401, "ALCF Inference sign-in is required")

    def _usable(self, token: dict | None) -> bool:
        return bool(token and token["resource_server"] == INFERENCE_RS
                    and token["client_id"] == self.config.client_id
                    and token["expires_at"] - float(self.now()) > REFRESH_LEAD)

    @staticmethod
    def _version(token: dict | None) -> tuple | None:
        if not token:
            return None
        return token["access_token"], token["refresh_token"], token["expires_at"]

    @staticmethod
    def _credential(token: dict) -> dict:
        return {"access_token": token["access_token"], "expires_at": token["expires_at"]}

    def inference_access_token(self, tenant: str, force: bool = False) -> str:
        return self.inference_credential(tenant, force)["access_token"]

    def inference_credential(self, tenant: str, force: bool = False) -> dict:
        token = self.store.inference(tenant)
        if token and (token["resource_server"] != INFERENCE_RS or token["client_id"] != self.config.client_id):
            raise self._reauth()
        if not force:
            if tenant in self._reauth_required:
                raise self._reauth()
            if self._usable(token):
                return self._credential(token)
        if not token:
            raise self._reauth()
        observed = self._version(token)
        with self._refresh_lock(tenant):
            token = self.store.inference(tenant)
            if not token or token["resource_server"] != INFERENCE_RS or token["client_id"] != self.config.client_id:
                raise self._reauth()
            if not force and tenant in self._reauth_required:
                raise self._reauth()
            # A forced retry that waited behind another request must reuse that
            # request's rotated credential rather than force a second rotation.
            if self._usable(token) and (not force or self._version(token) != observed):
                return self._credential(token)
            client = self.client_factory(self.config)
            try:
                response = client.oauth2_refresh_token(token["refresh_token"])
            except globus_sdk.GlobusAPIError as error:
                raw = getattr(error, "raw_json", None)
                oauth_error = raw.get("error") if isinstance(raw, dict) else None
                if error.http_status in (400, 401) and (error.code == "invalid_grant" or oauth_error == "invalid_grant"):
                    self._reauth_required.add(tenant)
                    raise self._reauth() from None
                raise AuthError(502, "ALCF Inference refresh failed") from None
            except Exception:
                raise AuthError(502, "ALCF Inference refresh failed") from None
            resource = response.by_resource_server.get(INFERENCE_RS) or {}
            access = resource.get("access_token")
            refresh = resource.get("refresh_token") or token["refresh_token"]
            expires = _expiry(resource)
            if (not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh
                    or expires is None or expires <= float(self.now())):
                raise AuthError(502, "ALCF Inference refresh returned invalid credentials")
            fresh = {
                "access_token": access,
                "refresh_token": refresh,
                "resource_server": INFERENCE_RS,
                "client_id": self.config.client_id,
                "expires_at": expires,
            }
            self.store.save_inference(tenant, fresh)
            self._reauth_required.discard(tenant)
            return self._credential(fresh)

    def inference_status(self, tenant: str) -> dict:
        token = self.store.inference(tenant)
        if (not token or token["resource_server"] != INFERENCE_RS or token["client_id"] != self.config.client_id
                or tenant in self._reauth_required):
            return {"connected": False, "needs_reauth": True, "expires_at": None}
        needs_reauth = token["expires_at"] <= float(self.now())
        return {
            "connected": not needs_reauth,
            "needs_reauth": needs_reauth,
            "expires_at": token["expires_at"],
        }


def default() -> GlobusAuth:
    """Build the process-wide auth service from owner-only deployment files."""
    import kb

    data = kb.data_dir()
    config = Config.load(data / "globus-auth.json")
    store = UserStore(data / "users", data / "auth" / "sessions.json")
    return GlobusAuth(config, store)
