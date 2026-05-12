"""Schemas for gateway CRUD and template-sync API payloads."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import field_validator
from sqlmodel import Field, SQLModel

RUNTIME_ANNOTATION_TYPES = (datetime, UUID)


class GatewayBase(SQLModel):
    """Shared gateway fields used across create/read payloads."""

    name: str
    url: str
    workspace_root: str
    allow_insecure_tls: bool = False
    disable_device_pairing: bool = False


class GatewayCreate(GatewayBase):
    """Payload for creating a gateway configuration."""

    token: str | None = None

    @field_validator("token", mode="before")
    @classmethod
    def normalize_token(cls, value: object) -> str | None | object:
        """Normalize empty/whitespace tokens to `None`."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value


class GatewayUpdate(SQLModel):
    """Payload for partial gateway updates."""

    name: str | None = None
    url: str | None = None
    token: str | None = None
    workspace_root: str | None = None
    allow_insecure_tls: bool | None = None
    disable_device_pairing: bool | None = None

    @field_validator("token", mode="before")
    @classmethod
    def normalize_token(cls, value: object) -> str | None | object:
        """Normalize empty/whitespace tokens to `None`."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value


class GatewayRead(GatewayBase):
    """Gateway payload returned from read endpoints."""

    id: UUID
    organization_id: UUID
    token: str | None = None
    created_at: datetime
    updated_at: datetime


class GatewayTemplatesSyncError(SQLModel):
    """Per-agent error entry from a gateway template sync operation."""

    agent_id: UUID | None = None
    agent_name: str | None = None
    board_id: UUID | None = None
    message: str


class GatewayTemplatesSyncResult(SQLModel):
    """Summary payload returned by gateway template sync endpoints."""

    gateway_id: UUID
    include_main: bool
    reset_sessions: bool
    agents_updated: int
    agents_skipped: int
    main_updated: bool
    errors: list[GatewayTemplatesSyncError] = Field(default_factory=list)


class GatewayDiscoveredAgent(SQLModel):
    """One discovered runtime agent with its mc-v2 representation."""

    runtime_id: str = Field(
        description="Agent id as reported by OpenClaw's `agents.list` RPC.",
    )
    name: str = Field(description="Display name (falls back to runtime_id).")
    workspace: str | None = None
    agent_runtime: str | None = Field(
        default=None,
        description="OpenClaw runtime engine for the agent (e.g. 'pi').",
    )
    model_primary: str | None = Field(
        default=None,
        description="Primary model alias as configured on the gateway.",
    )
    is_new: bool = Field(
        description="True when the discover call inserted a new Agent row.",
    )
    agent_id: UUID = Field(
        description="The mc-v2 Agent row UUID (existing or just-created).",
    )


class GatewayDiscoveryResult(SQLModel):
    """Summary payload returned by the gateway discover endpoint."""

    gateway_id: UUID
    discovered: int = Field(description="Runtime agents returned by `agents.list`.")
    imported: int = Field(description="Newly-inserted Agent rows.")
    matched: int = Field(
        description="Runtime agents that already existed in mc-v2's `agents` table.",
    )
    drift_in_db_only: list[UUID] = Field(
        default_factory=list,
        description=(
            "Agent rows in mc-v2 whose `openclaw_session_id` no longer appears "
            "on the gateway runtime. Operator should review and decide to delete "
            "or re-provision."
        ),
    )
    agents: list[GatewayDiscoveredAgent] = Field(default_factory=list)
    bootstrap_board_id: UUID | None = Field(
        default=None,
        description=(
            "If `create_board=true` was passed and no board existed for this "
            "gateway, the UUID of the freshly-created default board."
        ),
    )
