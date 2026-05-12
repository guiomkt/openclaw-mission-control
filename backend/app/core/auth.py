"""User authentication helpers for Clerk, local-token, and Supabase auth modes.

This module resolves an authenticated *user* from inbound HTTP requests.

Auth modes:
- `local`: a single shared bearer token (`LOCAL_AUTH_TOKEN`) for self-hosted
  deployments.
- `clerk`: Clerk JWT authentication for multi-user deployments.
- `supabase`: Supabase Auth — JWTs signed with either ES256 (asymmetric, the
  default for projects created after Apr 2025) or HS256 (legacy, shared
  secret). We pick the verification path from the JWT header's `alg`/`kid`;
  ES256 keys are fetched from the project's JWKS endpoint, HS256 keys from
  `SUPABASE_JWT_SECRET`. The `sub` claim (UUID) is stored in the existing
  `users.clerk_user_id` column; the column name predates this provider, but
  the semantics are identical (opaque external identifier).

The public surface area is the `get_auth_context*` dependencies, which return an
`AuthContext` used across API routers.

Notes:
- This file documents *why* some choices exist (e.g. claim extraction fallbacks)
  so maintainers can safely modify auth behavior later.
"""

from __future__ import annotations

from dataclasses import dataclass
from hmac import compare_digest
from typing import TYPE_CHECKING, Literal

import httpx
import jwt
from jwt import InvalidTokenError, PyJWTError
from clerk_backend_api import Clerk
from clerk_backend_api.models.clerkerrors import ClerkErrors
from clerk_backend_api.models.sdkerror import SDKError
from clerk_backend_api.security.types import AuthenticateRequestOptions, AuthStatus, RequestState
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from app.core.auth_mode import AuthMode
from app.core.config import settings
from app.core.logging import get_logger
from app.db import crud
from app.db.session import get_session
from app.models.users import User

if TYPE_CHECKING:
    from clerk_backend_api.models.user import User as ClerkUser
    from sqlmodel.ext.asyncio.session import AsyncSession

logger = get_logger(__name__)
security = HTTPBearer(auto_error=False)
SECURITY_DEP = Depends(security)
SESSION_DEP = Depends(get_session)
LOCAL_AUTH_USER_ID = "local-auth-user"
LOCAL_AUTH_EMAIL = "admin@home.local"
LOCAL_AUTH_NAME = "Local User"


class ClerkTokenPayload(BaseModel):
    """JWT claims payload shape required from Clerk tokens."""

    sub: str


@dataclass
class AuthContext:
    """Authenticated user context resolved from inbound auth headers."""

    actor_type: Literal["user"]
    user: User | None = None


def _extract_bearer_token(authorization: str | None) -> str | None:
    """Extract the bearer token from an `Authorization` header.

    Returns `None` for missing/empty headers or non-bearer schemes.

    Note: we do *not* validate the token here; this helper is only responsible for parsing.
    """

    if not authorization:
        return None
    value = authorization.strip()
    if not value:
        return None
    if not value.lower().startswith("bearer "):
        return None
    token = value.split(" ", maxsplit=1)[1].strip()
    return token or None


def _non_empty_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_email(value: object) -> str | None:
    text = _non_empty_str(value)
    if text is None:
        return None
    return text.lower()


def _extract_claim_email(claims: dict[str, object]) -> str | None:
    """Best-effort extraction of an email address from Clerk/JWT-like claims.

    Clerk payloads vary depending on token type and SDK version. We try common flat keys first,
    then fall back to an `email_addresses` list (either strings or dict-like entries).

    Returns a normalized lowercase email or `None`.
    """

    for key in ("email", "email_address", "primary_email_address"):
        email = _normalize_email(claims.get(key))
        if email:
            return email

    primary_email_id = _non_empty_str(claims.get("primary_email_address_id"))
    email_addresses = claims.get("email_addresses")
    if not isinstance(email_addresses, list):
        return None

    fallback_email: str | None = None
    for item in email_addresses:
        if isinstance(item, str):
            normalized = _normalize_email(item)
            if normalized and fallback_email is None:
                fallback_email = normalized
            continue
        if not isinstance(item, dict):
            continue
        candidate = _normalize_email(item.get("email_address") or item.get("email"))
        if not candidate:
            continue
        candidate_id = _non_empty_str(item.get("id"))
        if primary_email_id and candidate_id == primary_email_id:
            return candidate
        if fallback_email is None:
            fallback_email = candidate

    return fallback_email


def _extract_claim_name(claims: dict[str, object]) -> str | None:
    """Best-effort extraction of a display name from Clerk/JWT-like claims."""

    for key in ("name", "full_name"):
        text = _non_empty_str(claims.get(key))
        if text:
            return text

    first = _non_empty_str(claims.get("given_name")) or _non_empty_str(claims.get("first_name"))
    last = _non_empty_str(claims.get("family_name")) or _non_empty_str(claims.get("last_name"))
    parts = [part for part in (first, last) if part]
    if not parts:
        return None
    return " ".join(parts)


def _extract_clerk_profile(profile: ClerkUser | None) -> tuple[str | None, str | None]:
    """Extract `(email, name)` from a Clerk user profile.

    The Clerk SDK surface is not perfectly consistent across environments:
    - some fields may be absent,
    - email addresses may be represented as strings or objects,
    - the "primary" email may be identified by id.

    This helper implements a defensive, best-effort extraction strategy and returns `(None, None)`
    when the profile is unavailable.
    """

    if profile is None:
        return None, None

    profile_email = _normalize_email(getattr(profile, "email_address", None))
    primary_email_id = _non_empty_str(getattr(profile, "primary_email_address_id", None))
    emails = getattr(profile, "email_addresses", None)
    if not profile_email and isinstance(emails, list):
        fallback_email: str | None = None
        for item in emails:
            candidate = _normalize_email(
                getattr(item, "email_address", None),
            )
            if not candidate:
                continue
            candidate_id = _non_empty_str(getattr(item, "id", None))
            if primary_email_id and candidate_id == primary_email_id:
                profile_email = candidate
                break
            if fallback_email is None:
                fallback_email = candidate
        if profile_email is None:
            profile_email = fallback_email

    profile_name = (
        _non_empty_str(getattr(profile, "full_name", None))
        or _non_empty_str(getattr(profile, "name", None))
        or _non_empty_str(getattr(profile, "first_name", None))
        or _non_empty_str(getattr(profile, "username", None))
    )
    if not profile_name:
        first = _non_empty_str(getattr(profile, "first_name", None))
        last = _non_empty_str(getattr(profile, "last_name", None))
        parts = [part for part in (first, last) if part]
        if parts:
            profile_name = " ".join(parts)

    return profile_email, profile_name


def _normalize_clerk_server_url(raw: str) -> str | None:
    server_url = raw.strip().rstrip("/")
    if not server_url:
        return None
    if not server_url.endswith("/v1"):
        server_url = f"{server_url}/v1"
    return server_url


def _make_authenticate_request_options() -> AuthenticateRequestOptions:
    # Follow the clerk-backend-api documented flow: authenticate_request() with a secret key.
    return AuthenticateRequestOptions(
        secret_key=settings.clerk_secret_key.strip(),
        clock_skew_in_ms=int(settings.clerk_leeway * 1000),
        accepts_token=["session_token"],
    )


async def _authenticate_clerk_request(request: Request) -> RequestState:
    # The SDK docs use httpx.Request as the request object; build one from the ASGI request.
    httpx_request = httpx.Request(
        request.method,
        str(request.url),
        headers=dict(request.headers),
    )
    options = _make_authenticate_request_options()
    sdk = Clerk(bearer_auth=options.secret_key or "")
    return await run_in_threadpool(sdk.authenticate_request, httpx_request, options)


async def _fetch_clerk_profile(clerk_user_id: str) -> tuple[str | None, str | None]:
    secret = settings.clerk_secret_key.strip()
    server_url = _normalize_clerk_server_url(settings.clerk_api_url or "")
    clerk_user_id_log = clerk_user_id[-6:] if clerk_user_id else ""

    try:
        async with Clerk(
            bearer_auth=secret,
            server_url=server_url,
            timeout_ms=5000,
        ) as clerk:
            profile = await clerk.users.get_async(user_id=clerk_user_id)
        email, name = _extract_clerk_profile(profile)
        return email, name
    except ClerkErrors as exc:
        logger.warning(
            "auth.clerk.profile.fetch_failed clerk_user_id=%s reason=clerk_errors " "error_type=%s",
            clerk_user_id_log,
            exc.__class__.__name__,
        )
    except SDKError as exc:
        logger.warning(
            "auth.clerk.profile.fetch_failed clerk_user_id=%s status=%s reason=sdk_error "
            "server_url=%s",
            clerk_user_id_log,
            exc.status_code,
            server_url,
        )
    except httpx.TimeoutException as exc:
        logger.warning(
            "auth.clerk.profile.fetch_failed clerk_user_id=%s reason=timeout "
            "server_url=%s error=%s",
            clerk_user_id_log,
            server_url,
            str(exc) or exc.__class__.__name__,
        )
    except Exception as exc:
        logger.warning(
            "auth.clerk.profile.fetch_failed clerk_user_id=%s reason=sdk_exception "
            "error_type=%s error=%s",
            clerk_user_id_log,
            exc.__class__.__name__,
            str(exc)[:300],
        )
    return None, None


async def delete_clerk_user(clerk_user_id: str) -> None:
    """Delete a Clerk user via the official Clerk SDK."""
    if settings.auth_mode != AuthMode.CLERK:
        return

    secret = settings.clerk_secret_key.strip()
    server_url = _normalize_clerk_server_url(settings.clerk_api_url or "")
    clerk_user_id_log = clerk_user_id[-6:] if clerk_user_id else ""

    try:
        async with Clerk(
            bearer_auth=secret,
            server_url=server_url,
            timeout_ms=5000,
        ) as clerk:
            await clerk.users.delete_async(user_id=clerk_user_id)
        logger.info("auth.clerk.user.delete clerk_user_id=%s", clerk_user_id_log)
    except ClerkErrors as exc:
        logger.warning(
            "auth.clerk.user.delete_failed clerk_user_id=%s reason=clerk_errors " "error_type=%s",
            clerk_user_id_log,
            exc.__class__.__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to delete account from Clerk",
        ) from exc
    except SDKError as exc:
        if exc.status_code == 404:
            logger.info("auth.clerk.user.delete_missing clerk_user_id=%s", clerk_user_id_log)
            return
        logger.warning(
            "auth.clerk.user.delete_failed clerk_user_id=%s status=%s reason=sdk_error "
            "server_url=%s",
            clerk_user_id_log,
            exc.status_code,
            server_url,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to delete account from Clerk",
        ) from exc
    except Exception as exc:
        logger.warning(
            "auth.clerk.user.delete_failed clerk_user_id=%s reason=sdk_exception",
            clerk_user_id_log,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to delete account from Clerk",
        ) from exc


async def _get_or_sync_user(
    session: AsyncSession,
    *,
    clerk_user_id: str,
    claims: dict[str, object],
) -> User:
    clerk_user_id_log = clerk_user_id[-6:] if clerk_user_id else ""
    claim_email = _extract_claim_email(claims)
    claim_name = _extract_claim_name(claims)
    defaults: dict[str, object | None] = {
        "email": claim_email,
        "name": claim_name,
    }
    user, created = await crud.get_or_create(
        session,
        User,
        clerk_user_id=clerk_user_id,
        defaults=defaults,
    )

    profile_email: str | None = None
    profile_name: str | None = None
    # Avoid a network roundtrip to Clerk on every request once core profile
    # fields are present in our DB. The Clerk roundtrip is also nonsensical
    # outside Clerk mode — supabase/local don't have a profile API here, and
    # the secret in the env wouldn't authenticate against api.clerk.com.
    should_fetch_profile = (
        settings.auth_mode == AuthMode.CLERK
        and (created or not user.email or not user.name)
    )
    if should_fetch_profile:
        profile_email, profile_name = await _fetch_clerk_profile(clerk_user_id)

    email = profile_email or claim_email
    name = profile_name or claim_name

    changed = False
    if email and user.email != email:
        user.email = email
        changed = True
    if not user.name and name:
        user.name = name
        changed = True
    if changed:
        session.add(user)
        await session.commit()
        await session.refresh(user)
        logger.info(
            "auth.user.sync clerk_user_id=%s updated=%s fetched_profile=%s",
            clerk_user_id_log,
            changed,
            should_fetch_profile,
        )
    else:
        logger.debug(
            "auth.user.sync.noop clerk_user_id=%s fetched_profile=%s",
            clerk_user_id_log,
            should_fetch_profile,
        )
    if not user.email:
        logger.warning(
            "auth.user.sync.missing_email clerk_user_id=%s",
            clerk_user_id_log,
        )
    return user


async def _get_or_create_local_user(session: AsyncSession) -> User:
    defaults: dict[str, object] = {
        "email": LOCAL_AUTH_EMAIL,
        "name": LOCAL_AUTH_NAME,
    }
    user, _created = await crud.get_or_create(
        session,
        User,
        clerk_user_id=LOCAL_AUTH_USER_ID,
        defaults=defaults,
    )
    changed = False
    if not user.email:
        user.email = LOCAL_AUTH_EMAIL
        changed = True
    if not user.name:
        user.name = LOCAL_AUTH_NAME
        changed = True
    if changed:
        session.add(user)
        await session.commit()
        await session.refresh(user)

    from app.services.organizations import ensure_member_for_user

    await ensure_member_for_user(session, user)
    return user


async def _resolve_local_auth_context(
    *,
    request: Request,
    session: AsyncSession,
    required: bool,
) -> AuthContext | None:
    token = _extract_bearer_token(request.headers.get("Authorization"))
    if token is None:
        if required:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return None
    expected = settings.local_auth_token.strip()
    if not expected or not compare_digest(token, expected):
        if required:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return None
    user = await _get_or_create_local_user(session)
    return AuthContext(actor_type="user", user=user)


def _parse_subject(claims: dict[str, object]) -> str | None:
    payload = ClerkTokenPayload.model_validate(claims)
    return payload.sub


_SUPABASE_JWKS_CLIENT: jwt.PyJWKClient | None = None
_SUPABASE_JWKS_URL: str | None = None


def _get_supabase_jwks_client() -> jwt.PyJWKClient | None:
    """Return a cached PyJWKClient pointed at `SUPABASE_URL`'s JWKS endpoint.

    PyJWKClient caches keys for the duration of the process (15-minute TTL
    by default), which matches Supabase's published rotation cadence. We
    rebuild the client only when `SUPABASE_URL` changes (effectively never
    at runtime, but defensive against test reconfiguration).
    """
    global _SUPABASE_JWKS_CLIENT, _SUPABASE_JWKS_URL
    base = settings.supabase_url.strip().rstrip("/")
    if not base:
        return None
    jwks_url = f"{base}/auth/v1/.well-known/jwks.json"
    if _SUPABASE_JWKS_CLIENT is None or _SUPABASE_JWKS_URL != jwks_url:
        _SUPABASE_JWKS_CLIENT = jwt.PyJWKClient(jwks_url, cache_keys=True)
        _SUPABASE_JWKS_URL = jwks_url
    return _SUPABASE_JWKS_CLIENT


def _decode_supabase_token(token: str) -> dict[str, object] | None:
    """Validate a Supabase access token and return its claims, or None on failure.

    Supabase signs JWTs with one of two algorithms:
    - **ES256** (default for projects created after Apr 2025; "asymmetric
      JWT signing keys"). Public keys are published at the project's
      `/.well-known/jwks.json` endpoint and indexed by `kid`.
    - **HS256** (legacy). Shared secret is `SUPABASE_JWT_SECRET`
      (Project Settings → API → JWT Settings).

    We dispatch on the header's `alg` so dual-mode projects mid-migration
    still work; we accept both algorithms when both are configured.

    Audience is `authenticated` for normal user tokens; service-role and
    anon tokens get rejected at the user-resolution stage (no matching
    `sub` in our DB). PyJWT enforces `exp` and the leeway already used by
    the Clerk path.
    """
    try:
        header = jwt.get_unverified_header(token)
    except (InvalidTokenError, PyJWTError) as exc:
        logger.info("auth.supabase.invalid_token reason=%s", exc.__class__.__name__)
        return None

    alg = header.get("alg")
    common_options = {
        "options": {"require": ["exp", "sub"]},
        "leeway": settings.supabase_leeway,
        "audience": "authenticated",
    }

    try:
        if alg == "HS256":
            secret = settings.supabase_jwt_secret.strip()
            if not secret:
                logger.info("auth.supabase.invalid_token reason=NoHS256SecretConfigured")
                return None
            return jwt.decode(  # type: ignore[no-any-return]
                token,
                secret,
                algorithms=["HS256"],
                **common_options,
            )
        if alg in ("ES256", "RS256", "EdDSA"):
            client = _get_supabase_jwks_client()
            if client is None:
                logger.info("auth.supabase.invalid_token reason=NoJWKSConfigured")
                return None
            signing_key = client.get_signing_key_from_jwt(token).key
            return jwt.decode(  # type: ignore[no-any-return]
                token,
                signing_key,
                algorithms=[alg],
                **common_options,
            )
        logger.info("auth.supabase.invalid_token reason=UnsupportedAlg alg=%s", alg)
        return None
    except InvalidTokenError as exc:
        logger.info("auth.supabase.invalid_token reason=%s", exc.__class__.__name__)
        return None
    except PyJWTError as exc:
        logger.warning("auth.supabase.jwt_error reason=%s", exc.__class__.__name__)
        return None


async def _resolve_supabase_auth_context(
    *,
    request: Request,
    session: AsyncSession,
    required: bool,
) -> AuthContext | None:
    """Bearer-token Supabase JWT → AuthContext, reusing the Clerk user-sync path.

    The user-upsert helper (`_get_or_sync_user`) is named for Clerk but is
    keyed on an opaque external id — exactly what Supabase's `sub` is. We
    skip the Clerk profile fetch by passing claims that already contain
    email/name; `_fetch_clerk_profile` is only triggered when those are
    missing.
    """
    token = _extract_bearer_token(request.headers.get("Authorization"))
    if token is None:
        if required:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return None

    claims = _decode_supabase_token(token)
    if claims is None:
        if required:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return None

    sub = _non_empty_str(claims.get("sub"))
    if not sub:
        if required:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return None

    # Supabase places email/name where _extract_claim_email/_extract_claim_name
    # already look (top-level "email", and "user_metadata.name" via the
    # generic `name`/`full_name` keys when set during signup). Flatten the
    # `user_metadata` block so the Clerk-style extractors still find them.
    user_metadata = claims.get("user_metadata")
    if isinstance(user_metadata, dict):
        for k, v in user_metadata.items():
            claims.setdefault(str(k), v)

    user = await _get_or_sync_user(
        session,
        clerk_user_id=sub,
        claims=claims,
    )
    from app.services.organizations import ensure_member_for_user

    await ensure_member_for_user(session, user)
    return AuthContext(actor_type="user", user=user)


async def get_auth_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = SECURITY_DEP,
    session: AsyncSession = SESSION_DEP,
) -> AuthContext:
    """Resolve required authenticated user context for the configured auth mode."""
    if settings.auth_mode == AuthMode.LOCAL:
        local_auth = await _resolve_local_auth_context(
            request=request,
            session=session,
            required=True,
        )
        if local_auth is None:  # pragma: no cover
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return local_auth

    if settings.auth_mode == AuthMode.SUPABASE:
        supabase_auth = await _resolve_supabase_auth_context(
            request=request,
            session=session,
            required=True,
        )
        if supabase_auth is None:  # pragma: no cover
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return supabase_auth

    request_state = await _authenticate_clerk_request(request)
    if request_state.status != AuthStatus.SIGNED_IN or not isinstance(request_state.payload, dict):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    claims: dict[str, object] = {str(k): v for k, v in request_state.payload.items()}
    try:
        clerk_user_id = _parse_subject(claims)
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED) from exc

    if not clerk_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    user = await _get_or_sync_user(
        session,
        clerk_user_id=clerk_user_id,
        claims=claims,
    )
    from app.services.organizations import ensure_member_for_user

    await ensure_member_for_user(session, user)

    return AuthContext(
        actor_type="user",
        user=user,
    )


async def get_auth_context_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = SECURITY_DEP,
    session: AsyncSession = SESSION_DEP,
) -> AuthContext | None:
    """Resolve user context if available, otherwise return `None`."""
    if request.headers.get("X-Agent-Token"):
        return None
    if settings.auth_mode == AuthMode.LOCAL:
        return await _resolve_local_auth_context(
            request=request,
            session=session,
            required=False,
        )

    if settings.auth_mode == AuthMode.SUPABASE:
        return await _resolve_supabase_auth_context(
            request=request,
            session=session,
            required=False,
        )

    request_state = await _authenticate_clerk_request(request)
    if request_state.status != AuthStatus.SIGNED_IN or not isinstance(request_state.payload, dict):
        return None
    claims: dict[str, object] = {str(k): v for k, v in request_state.payload.items()}

    try:
        clerk_user_id = _parse_subject(claims)
    except ValidationError:
        return None

    if not clerk_user_id:
        return None
    user = await _get_or_sync_user(
        session,
        clerk_user_id=clerk_user_id,
        claims=claims,
    )
    from app.services.organizations import ensure_member_for_user

    await ensure_member_for_user(session, user)

    return AuthContext(
        actor_type="user",
        user=user,
    )
