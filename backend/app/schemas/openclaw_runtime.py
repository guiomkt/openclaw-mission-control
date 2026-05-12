"""Response schemas for the /api/v1/openclaw runtime passthrough router.

These schemas typecheck the shape of each gateway RPC payload that the
operator-facing UI consumes. They are intentionally lenient (use `dict[str,
object]` for inner objects) because the OpenClaw protocol is versioned
independently and we don't want a tight schema to brick the UI on a minor
gateway update — the frontend renders fields it knows about and ignores the
rest.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlmodel import Field, SQLModel

RUNTIME_ANNOTATION_TYPES = (datetime, UUID)


class RuntimeAgentEntry(SQLModel):
    """One agent entry from `agents.list`."""

    id: str
    name: str | None = None
    workspace: str | None = None
    agent_runtime: str | None = None
    model_primary: str | None = None
    heartbeat: dict[str, Any] | None = None
    identity: dict[str, Any] | None = None
    subagents_allow: list[str] | None = None


class RuntimeAgentsResponse(SQLModel):
    default_id: str | None = None
    agents: list[RuntimeAgentEntry] = Field(default_factory=list)


class ChannelAccountStatus(SQLModel):
    account_id: str | None = None
    label: str | None = None
    connected: bool | None = None
    configured: bool | None = None
    running: bool | None = None
    enabled: bool | None = None
    extra: dict[str, Any] | None = None


class ChannelStatusEntry(SQLModel):
    channel: str
    accounts: list[ChannelAccountStatus] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class ChannelsStatusResponse(SQLModel):
    channels: list[ChannelStatusEntry] = Field(default_factory=list)


class CronEntry(SQLModel):
    id: str
    name: str | None = None
    schedule: str | None = None
    target_agent: str | None = None
    enabled: bool | None = None
    last_run: datetime | None = None
    next_run: datetime | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class CronListResponse(SQLModel):
    crons: list[CronEntry] = Field(default_factory=list)


class CronRunEntry(SQLModel):
    id: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    status: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class CronRunsResponse(SQLModel):
    runs: list[CronRunEntry] = Field(default_factory=list)


class CronMutateResponse(SQLModel):
    """Returned by add/update/remove/run. May indicate the gateway restarted."""

    ok: bool = True
    restart_absorbed: bool = False
    cron: dict[str, Any] | None = None


class CronCreateRequest(SQLModel):
    schedule: str
    target_agent: str
    message: str | None = None
    name: str | None = None
    enabled: bool = True


class CronUpdateRequest(SQLModel):
    schedule: str | None = None
    target_agent: str | None = None
    message: str | None = None
    name: str | None = None
    enabled: bool | None = None


class UsageCostRow(SQLModel):
    provider: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    cost_usd: float | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class UsageCostResponse(SQLModel):
    range_start: datetime | None = None
    range_end: datetime | None = None
    total_cost_usd: float | None = None
    by_provider: list[UsageCostRow] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class UsageStatusResponse(SQLModel):
    raw: dict[str, Any] = Field(default_factory=dict)


class ModelEntry(SQLModel):
    id: str
    alias: str | None = None
    provider: str | None = None
    primary: bool = False
    fallback: bool = False
    raw: dict[str, Any] = Field(default_factory=dict)


class ModelsListResponse(SQLModel):
    models: list[ModelEntry] = Field(default_factory=list)


class AgentFileEntry(SQLModel):
    name: str
    path: str | None = None
    size: int | None = None
    updated_at: datetime | None = None
    missing: bool | None = None


class AgentFilesListResponse(SQLModel):
    agent_id: str
    workspace: str | None = None
    files: list[AgentFileEntry] = Field(default_factory=list)


class AgentFileContentResponse(SQLModel):
    agent_id: str
    name: str
    content: str
    size: int | None = None


class AgentFileWriteRequest(SQLModel):
    content: str
