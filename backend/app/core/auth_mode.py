"""Shared auth-mode enum values."""

from __future__ import annotations

from enum import Enum


class AuthMode(str, Enum):
    """Supported authentication modes for backend and frontend."""

    CLERK = "clerk"
    LOCAL = "local"
    # Supabase Auth — validates HS256-signed access tokens with the project's
    # JWT Secret. The `sub` claim (Supabase user UUID) is stored in the
    # existing `users.clerk_user_id` column; the column name predates this
    # provider but the semantics are identical (opaque external identifier).
    SUPABASE = "supabase"
