"""Application-level encryption for sensitive string columns.

Why not pgcrypto: Supabase's Postgres supports it, but the DB-side approach
requires the secret to be passed in every query (or stored as a DB GUC,
which would put it in `pg_stat_statements`). Application-level Fernet keeps
the key in the backend process only and is transparent to callers: model
fields look like regular `str`, and the ciphertext (urlsafe base64) lives
in a normal `TEXT` column.

Currently used for `Gateway.token`, which holds OpenClaw gateway secrets
and would otherwise sit in cleartext alongside the rest of the rows in
Supabase Cloud Postgres.
"""

from __future__ import annotations

import base64
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.types import String, TypeDecorator

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _normalize_fernet_key(raw: str) -> bytes:
    """Accept either Fernet-native (urlsafe b64 of 32 bytes) or plain b64.

    Operators tend to reach for `openssl rand -base64 32`, which produces
    standard base64. Fernet wants the urlsafe variant. We translate so the
    config value is forgiving either way; anything else raises.
    """
    cleaned = raw.strip().encode("ascii")
    try:
        Fernet(cleaned)
        return cleaned
    except (ValueError, TypeError):
        # Fall through and try a re-encoding.
        pass

    try:
        decoded = base64.b64decode(cleaned)
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError(
            "GATEWAY_TOKEN_ENCRYPTION_KEY is not valid base64. "
            "Generate with: openssl rand -base64 32",
        ) from exc

    if len(decoded) != 32:
        raise ValueError(
            "GATEWAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes "
            f"(got {len(decoded)}). Generate with: openssl rand -base64 32",
        )

    return base64.urlsafe_b64encode(decoded)


class EncryptedStr(TypeDecorator[str]):
    """Fernet-encrypted TEXT column.

    Reads return the plaintext `str`; writes encrypt with a key sourced
    from `settings.gateway_token_encryption_key`. The key is cached on the
    descriptor itself after first use to amortise the b64 normalisation.

    Re-keying requires a one-shot batch re-encryption job; not implemented
    here because the column is empty on first deploy.
    """

    impl = String
    cache_ok = True

    _cached_key: bytes | None = None

    def _fernet(self) -> Fernet:
        if EncryptedStr._cached_key is None:
            EncryptedStr._cached_key = _normalize_fernet_key(
                settings.gateway_token_encryption_key,
            )
        return Fernet(EncryptedStr._cached_key)

    def process_bind_param(self, value: Any, dialect: Dialect) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            value = str(value)
        return self._fernet().encrypt(value.encode("utf-8")).decode("ascii")

    def process_result_value(self, value: Any, dialect: Dialect) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            return None
        try:
            return self._fernet().decrypt(value.encode("ascii")).decode("utf-8")
        except InvalidToken:
            # Row pre-dates the encrypted column (or was tampered with).
            # Return None so the rest of the gateway record stays usable;
            # operator must re-enter the token in the UI to repair the row.
            logger.warning(
                "encrypted_str.decrypt_failed reason=invalid_token "
                "column_likely_unencrypted_or_corrupted",
            )
            return None
