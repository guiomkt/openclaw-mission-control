"""Operator-facing passthrough router for OpenClaw runtime data.

This module exposes the WebSocket RPC surface of the OpenClaw gateway over
authenticated HTTP so the mc-v2 frontend can render live operational state
(channels, crons, costs, models, per-agent memory files).

Why separate from `gateways.py`:
- `gateways.py` is the CRUD layer for the `public.gateways` table.
- `gateway.py` (singular) is the session-inspection layer (already wired:
  `sessions.list`, `chat.history`, `chat.send`).
- `openclaw_runtime.py` (this) is everything else operator-facing — the
  high-value RPCs the candidate declared but didn't wire (per the
  integration plan, Phase C).

Every route accepts a `gateway_id` UUID path param so authorization scopes
to the caller's organization. Each handler delegates to
`openclaw_call(...)` via the existing `GatewaySessionService.resolve_gateway`
which already enforces org access.

Endpoints intentionally normalize the gateway's raw RPC payloads into
Pydantic shapes (see `app.schemas.openclaw_runtime`) so the frontend
contract stays stable across minor gateway version bumps. Where a field's
exact shape varies, we expose `raw: dict[str, Any]` so the UI can still
render unknown bits.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.api.deps import require_org_admin
from app.core.auth import AuthContext, get_auth_context
from app.core.logging import get_logger
from app.db.session import get_session
from app.models.agents import Agent
from app.schemas.openclaw_runtime import (
    AgentFileContentResponse,
    AgentFileEntry,
    AgentFilesListResponse,
    AgentFileWriteRequest,
    ChannelAccountStatus,
    ChannelStatusEntry,
    ChannelsStatusResponse,
    CronCreateRequest,
    CronEntry,
    CronListResponse,
    CronMutateResponse,
    CronRunEntry,
    CronRunsResponse,
    CronUpdateRequest,
    ModelEntry,
    ModelsListResponse,
    RuntimeAgentEntry,
    RuntimeAgentsResponse,
    UsageCostResponse,
    UsageCostRow,
    UsageStatusResponse,
)
from app.services.openclaw.gateway_rpc import (
    GatewayConfig as GatewayClientConfig,
    OpenClawGatewayError,
    openclaw_call,
)
from app.services.openclaw.session_service import GatewaySessionService
from app.services.organizations import OrganizationContext

if TYPE_CHECKING:
    from sqlmodel.ext.asyncio.session import AsyncSession


logger = get_logger(__name__)
router = APIRouter(prefix="/openclaw", tags=["openclaw"])
SESSION_DEP = Depends(get_session)
AUTH_DEP = Depends(get_auth_context)
ORG_ADMIN_DEP = Depends(require_org_admin)


# --- helpers --------------------------------------------------------------


async def _resolve_config(
    gateway_id: UUID,
    session: AsyncSession,
    auth: AuthContext,
    ctx: OrganizationContext,
) -> GatewayClientConfig:
    """Resolve a saved gateway row → RPC client config, org-scoped."""
    svc = GatewaySessionService(session)
    params = svc.to_resolve_query(
        gateway_id=str(gateway_id),
        board_id=None,
        gateway_url=None,
        gateway_token=None,
    )
    _, config, _ = await svc.resolve_gateway(
        params,
        user=auth.user,
        organization_id=ctx.organization.id,
    )
    return config


async def _call_or_502(method: str, params: dict[str, Any] | None, *, config: GatewayClientConfig) -> object:
    """Call an OpenClaw RPC and convert errors to 502s for the UI."""
    try:
        return await openclaw_call(method, params, config=config)
    except OpenClawGatewayError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gateway RPC {method} failed: {exc}",
        ) from exc


def _parse_dt(value: object) -> datetime | None:
    """Best-effort parse for gateway timestamps (epoch ms or ISO-8601)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Heuristic: > 10^12 ⇒ epoch ms, else seconds. OpenClaw uses ms.
        try:
            ts = float(value) / 1000.0 if value > 10**12 else float(value)
            return datetime.utcfromtimestamp(ts)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


# --- 1. Runtime agents (Phase E uses this for drift too) ------------------


@router.get("/{gateway_id}/agents", response_model=RuntimeAgentsResponse)
async def list_runtime_agents(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> RuntimeAgentsResponse:
    """Return the live agents list as reported by `agents.list` on the gateway."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("agents.list", None, config=config)
    entries: list[RuntimeAgentEntry] = []
    default_id: str | None = None
    if isinstance(payload, dict):
        if isinstance(payload.get("defaultId"), str):
            default_id = payload["defaultId"]
        raw = payload.get("agents")
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                ar = item.get("agentRuntime")
                model = item.get("model")
                identity = item.get("identity")
                subagents = item.get("subagents")
                entries.append(
                    RuntimeAgentEntry(
                        id=str(item.get("id") or ""),
                        name=item.get("name") if isinstance(item.get("name"), str) else None,
                        workspace=item.get("workspace") if isinstance(item.get("workspace"), str) else None,
                        agent_runtime=(ar.get("id") if isinstance(ar, dict) else None),
                        model_primary=(
                            model.get("primary") if isinstance(model, dict) else (model if isinstance(model, str) else None)
                        ),
                        heartbeat=item.get("heartbeat") if isinstance(item.get("heartbeat"), dict) else None,
                        identity=identity if isinstance(identity, dict) else None,
                        subagents_allow=(
                            subagents.get("allowAgents") if isinstance(subagents, dict) and isinstance(subagents.get("allowAgents"), list) else None
                        ),
                    ),
                )
    return RuntimeAgentsResponse(default_id=default_id, agents=entries)


# --- 2. Channels ----------------------------------------------------------


@router.get("/{gateway_id}/channels", response_model=ChannelsStatusResponse)
async def channels_status(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> ChannelsStatusResponse:
    """Return per-channel + per-account connection state (`channels.status` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("channels.status", None, config=config)
    entries: list[ChannelStatusEntry] = []
    # OpenClaw's channels.status returns a top-level envelope with:
    #   - channels: { telegram: {...}, whatsapp: {...} }   (per-channel state)
    #   - channelAccounts: { telegram: { default: {...}, ... }, ... }
    # We flatten both into one entry per channel so the UI gets channel-level
    # health *and* per-account state in a single response shape.
    channels_block = payload.get("channels") if isinstance(payload, dict) else None
    accounts_block = payload.get("channelAccounts") if isinstance(payload, dict) else None
    if isinstance(channels_block, dict):
        for channel_name, channel_block in channels_block.items():
            if not isinstance(channel_block, dict):
                continue
            accounts: list[ChannelAccountStatus] = []
            # First check the dedicated channelAccounts map.
            ch_accounts = accounts_block.get(channel_name) if isinstance(accounts_block, dict) else None
            raw_accounts = ch_accounts if isinstance(ch_accounts, dict) else channel_block.get("accounts")
            if isinstance(raw_accounts, dict):
                for account_id, account_data in raw_accounts.items():
                    if not isinstance(account_data, dict):
                        continue
                    accounts.append(
                        ChannelAccountStatus(
                            account_id=str(account_id),
                            label=(
                                account_data.get("label") if isinstance(account_data.get("label"), str) else None
                            ),
                            connected=account_data.get("connected") if isinstance(account_data.get("connected"), bool) else None,
                            configured=account_data.get("configured") if isinstance(account_data.get("configured"), bool) else None,
                            running=account_data.get("running") if isinstance(account_data.get("running"), bool) else None,
                            enabled=account_data.get("enabled") if isinstance(account_data.get("enabled"), bool) else None,
                            extra={k: v for k, v in account_data.items() if k not in {"label", "connected", "configured", "running", "enabled"}} or None,
                        ),
                    )
            else:
                # Some channels return a flat shape — synthesise a "default" account.
                if any(k in channel_block for k in ("connected", "configured", "running", "enabled")):
                    accounts.append(
                        ChannelAccountStatus(
                            account_id="default",
                            connected=channel_block.get("connected") if isinstance(channel_block.get("connected"), bool) else None,
                            configured=channel_block.get("configured") if isinstance(channel_block.get("configured"), bool) else None,
                            running=channel_block.get("running") if isinstance(channel_block.get("running"), bool) else None,
                            enabled=channel_block.get("enabled") if isinstance(channel_block.get("enabled"), bool) else None,
                        ),
                    )
            entries.append(
                ChannelStatusEntry(channel=str(channel_name), accounts=accounts, raw=channel_block),
            )
    return ChannelsStatusResponse(channels=entries)


# --- 3. Crons (full CRUD + run) ------------------------------------------


def _cron_to_entry(item: dict[str, Any]) -> CronEntry:
    # OpenClaw cron schedules are nested objects: `{kind: 'cron', expr: '0 8-20/2 * * 1-5', tz: '...'}`.
    # Surface a flat string for the UI (the cron expr is the operator-meaningful bit).
    schedule_block = item.get("schedule")
    schedule_str: str | None = None
    if isinstance(schedule_block, dict):
        expr = schedule_block.get("expr")
        if isinstance(expr, str):
            schedule_str = expr
    elif isinstance(schedule_block, str):
        schedule_str = schedule_block
    return CronEntry(
        id=str(item.get("id") or ""),
        name=item.get("name") if isinstance(item.get("name"), str) else None,
        schedule=schedule_str,
        target_agent=(
            item.get("agentId") if isinstance(item.get("agentId"), str)
            else (item.get("targetAgent") if isinstance(item.get("targetAgent"), str) else None)
        ),
        enabled=item.get("enabled") if isinstance(item.get("enabled"), bool) else None,
        last_run=_parse_dt(item.get("lastRun") or item.get("lastRunAt")),
        next_run=_parse_dt(item.get("nextRun") or item.get("nextRunAt")),
        raw=item,
    )


@router.get("/{gateway_id}/crons", response_model=CronListResponse)
async def list_crons(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> CronListResponse:
    """List scheduled cron jobs (`cron.list` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("cron.list", None, config=config)
    crons: list[CronEntry] = []
    raw_list: list[Any] = []
    # OpenClaw returns `{ jobs: [...] }` (post-2026.05). Older versions used
    # `crons`. Accept either + bare-list fallback.
    if isinstance(payload, dict):
        for key in ("jobs", "crons"):
            v = payload.get(key)
            if isinstance(v, list):
                raw_list = v
                break
    elif isinstance(payload, list):
        raw_list = payload
    for item in raw_list:
        if isinstance(item, dict):
            crons.append(_cron_to_entry(item))
    return CronListResponse(crons=crons)


@router.get("/{gateway_id}/crons/{cron_id}/runs", response_model=CronRunsResponse)
async def list_cron_runs(
    gateway_id: UUID,
    cron_id: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> CronRunsResponse:
    """Execution history of a cron (`cron.runs` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("cron.runs", {"id": cron_id}, config=config)
    runs: list[CronRunEntry] = []
    raw_list: list[Any] = []
    if isinstance(payload, dict) and isinstance(payload.get("runs"), list):
        raw_list = payload["runs"]
    elif isinstance(payload, list):
        raw_list = payload
    for item in raw_list:
        if isinstance(item, dict):
            runs.append(
                CronRunEntry(
                    id=str(item.get("id") or ""),
                    started_at=_parse_dt(item.get("startedAt") or item.get("started_at")),
                    finished_at=_parse_dt(item.get("finishedAt") or item.get("finished_at")),
                    status=item.get("status") if isinstance(item.get("status"), str) else None,
                    raw=item,
                ),
            )
    return CronRunsResponse(runs=runs)


def _mutate_response(payload: object) -> CronMutateResponse:
    """Normalize a cron mutate RPC return.

    OpenClaw's gateway_rpc.py absorbs SIGUSR1 restart-closes by returning
    `{"ok": True, "restartAbsorbed": True}` (see commit f77cc39). Surface
    that signal to the UI so the frontend can refetch the cron list rather
    than treating it as a transparent success.
    """
    if isinstance(payload, dict):
        return CronMutateResponse(
            ok=bool(payload.get("ok", True)),
            restart_absorbed=bool(payload.get("restartAbsorbed", False)),
            cron=payload.get("cron") if isinstance(payload.get("cron"), dict) else None,
        )
    return CronMutateResponse()


@router.post("/{gateway_id}/crons", response_model=CronMutateResponse)
async def add_cron(
    gateway_id: UUID,
    body: CronCreateRequest,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> CronMutateResponse:
    """Create a new cron entry on the gateway (`cron.add` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    params: dict[str, Any] = {
        "schedule": body.schedule,
        "targetAgent": body.target_agent,
        "enabled": body.enabled,
    }
    if body.message is not None:
        params["message"] = body.message
    if body.name is not None:
        params["name"] = body.name
    payload = await _call_or_502("cron.add", params, config=config)
    return _mutate_response(payload)


@router.patch("/{gateway_id}/crons/{cron_id}", response_model=CronMutateResponse)
async def update_cron(
    gateway_id: UUID,
    cron_id: str,
    body: CronUpdateRequest,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> CronMutateResponse:
    """Patch a cron entry on the gateway (`cron.update` RPC).

    Pause / resume is just `enabled=false` / `enabled=true`. Send only the
    fields you want to change — `None` values are stripped before the RPC.
    """
    config = await _resolve_config(gateway_id, session, auth, ctx)
    params: dict[str, Any] = {"id": cron_id}
    if body.schedule is not None:
        params["schedule"] = body.schedule
    if body.target_agent is not None:
        params["targetAgent"] = body.target_agent
    if body.message is not None:
        params["message"] = body.message
    if body.name is not None:
        params["name"] = body.name
    if body.enabled is not None:
        params["enabled"] = body.enabled
    payload = await _call_or_502("cron.update", params, config=config)
    return _mutate_response(payload)


@router.delete("/{gateway_id}/crons/{cron_id}", response_model=CronMutateResponse)
async def remove_cron(
    gateway_id: UUID,
    cron_id: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> CronMutateResponse:
    """Delete a cron entry on the gateway (`cron.remove` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("cron.remove", {"id": cron_id}, config=config)
    return _mutate_response(payload)


@router.post("/{gateway_id}/crons/{cron_id}/run", response_model=CronMutateResponse)
async def run_cron(
    gateway_id: UUID,
    cron_id: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> CronMutateResponse:
    """Manually trigger a cron (`cron.run` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("cron.run", {"id": cron_id}, config=config)
    return _mutate_response(payload)


# --- 4. Logs tail (SSE) ---------------------------------------------------


@router.get("/{gateway_id}/logs/stream")
async def logs_stream(
    gateway_id: UUID,
    lines: int = Query(default=200, ge=0, le=2000),
    follow: bool = Query(default=True),
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> StreamingResponse:
    """Tail the gateway log via `logs.tail` and stream as Server-Sent Events.

    The RPC returns either a single batch (when `follow=false`) or an
    open stream of log entries. We bridge that to SSE so the browser can
    subscribe with `EventSource`.

    Note: when `follow=true` the underlying WebSocket stays open until the
    client disconnects. We poll for new entries every second; finer-grained
    push would require subscribing to the gateway's `system-event` stream
    which is a separate Phase E task.
    """
    config = await _resolve_config(gateway_id, session, auth, ctx)

    async def event_source() -> Any:
        # Initial fetch — capture last N lines (no follow yet).
        try:
            payload = await openclaw_call(
                "logs.tail",
                {"lines": lines, "follow": False},
                config=config,
            )
        except OpenClawGatewayError as exc:
            yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"
            return
        if isinstance(payload, dict) and isinstance(payload.get("entries"), list):
            for entry in payload["entries"]:
                yield f"data: {json.dumps(entry)}\n\n"
        if not follow:
            yield "event: done\ndata: {}\n\n"
            return

        # Follow loop: poll for new lines every 1s. Stop on client disconnect
        # (the StreamingResponse generator gets garbage-collected then).
        last_cursor = payload.get("cursor") if isinstance(payload, dict) else None
        while True:
            try:
                payload = await openclaw_call(
                    "logs.tail",
                    {"since": last_cursor, "follow": False},
                    config=config,
                )
            except OpenClawGatewayError as exc:
                yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"
                return
            if isinstance(payload, dict):
                for entry in payload.get("entries", []) or []:
                    yield f"data: {json.dumps(entry)}\n\n"
                last_cursor = payload.get("cursor") or last_cursor
            await asyncio.sleep(1.0)

    return StreamingResponse(event_source(), media_type="text/event-stream")


# --- 5. Usage / cost ------------------------------------------------------


@router.get("/{gateway_id}/usage/cost", response_model=UsageCostResponse)
async def usage_cost(
    gateway_id: UUID,
    range_from: str | None = Query(default=None, alias="from"),
    range_to: str | None = Query(default=None, alias="to"),
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> UsageCostResponse:
    """Per-provider cost summary (`usage.cost` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    params: dict[str, Any] = {}
    if range_from:
        params["from"] = range_from
    if range_to:
        params["to"] = range_to
    payload = await _call_or_502("usage.cost", params or None, config=config)
    rows: list[UsageCostRow] = []
    total: float | None = None
    if isinstance(payload, dict):
        if isinstance(payload.get("totalCostUsd"), (int, float)):
            total = float(payload["totalCostUsd"])
        by_provider = payload.get("byProvider")
        if isinstance(by_provider, list):
            for item in by_provider:
                if not isinstance(item, dict):
                    continue
                rows.append(
                    UsageCostRow(
                        provider=item.get("provider") if isinstance(item.get("provider"), str) else None,
                        model=item.get("model") if isinstance(item.get("model"), str) else None,
                        input_tokens=item.get("inputTokens") if isinstance(item.get("inputTokens"), int) else None,
                        output_tokens=item.get("outputTokens") if isinstance(item.get("outputTokens"), int) else None,
                        cache_read_tokens=item.get("cacheReadTokens") if isinstance(item.get("cacheReadTokens"), int) else None,
                        cache_write_tokens=item.get("cacheWriteTokens") if isinstance(item.get("cacheWriteTokens"), int) else None,
                        cost_usd=item.get("costUsd") if isinstance(item.get("costUsd"), (int, float)) else None,
                        raw=item,
                    ),
                )
    return UsageCostResponse(
        range_start=_parse_dt(payload.get("from") if isinstance(payload, dict) else None),
        range_end=_parse_dt(payload.get("to") if isinstance(payload, dict) else None),
        total_cost_usd=total,
        by_provider=rows,
        raw=payload if isinstance(payload, dict) else {},
    )


@router.get("/{gateway_id}/usage/status", response_model=UsageStatusResponse)
async def usage_status(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> UsageStatusResponse:
    """Aggregate usage snapshot (`usage.status` RPC). Returns raw payload."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("usage.status", None, config=config)
    return UsageStatusResponse(raw=payload if isinstance(payload, dict) else {})


# --- 6. Models -----------------------------------------------------------


@router.get("/{gateway_id}/models", response_model=ModelsListResponse)
async def list_models(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> ModelsListResponse:
    """Models configured on the gateway (`models.list` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    payload = await _call_or_502("models.list", None, config=config)
    models: list[ModelEntry] = []
    if isinstance(payload, dict):
        raw_list = payload.get("models")
        primary = payload.get("primary") if isinstance(payload.get("primary"), str) else None
        fallbacks: list[str] = payload.get("fallbacks") if isinstance(payload.get("fallbacks"), list) else []
        if isinstance(raw_list, list):
            for item in raw_list:
                if not isinstance(item, dict):
                    continue
                model_id = item.get("id")
                if not isinstance(model_id, str):
                    continue
                models.append(
                    ModelEntry(
                        id=model_id,
                        alias=item.get("alias") if isinstance(item.get("alias"), str) else None,
                        provider=item.get("provider") if isinstance(item.get("provider"), str) else None,
                        primary=(primary == model_id) if primary else False,
                        fallback=(model_id in fallbacks),
                        raw=item,
                    ),
                )
    return ModelsListResponse(models=models)


# --- 7. Per-agent memory editor ------------------------------------------


async def _resolve_runtime_agent_id(
    session: AsyncSession, gateway_id: UUID, agent_id: UUID,
) -> str:
    """Look up an mc-v2 Agent row and derive the gateway-side runtime id.

    For imported agents (`is_gateway_managed=true`) the runtime id is encoded
    in `openclaw_session_id` as `agent:{runtime_id}:main`. For synthetic
    gateway-main agents the runtime id is `mc-gateway-<gateway_uuid>`. This
    helper normalises both shapes.
    """
    agent = await Agent.objects.by_id(agent_id).first(session)
    if agent is None or agent.gateway_id != gateway_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent not found in this gateway",
        )
    key = agent.openclaw_session_id or ""
    # `agent:<runtime_id>:main`
    if key.startswith("agent:") and key.endswith(":main"):
        return key[len("agent:") : -len(":main")]
    return key or str(agent.id)


@router.get(
    "/{gateway_id}/agents/{agent_id}/files",
    response_model=AgentFilesListResponse,
)
async def list_agent_files(
    gateway_id: UUID,
    agent_id: UUID,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> AgentFilesListResponse:
    """List workspace files for an agent (`agents.files.list` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    runtime_id = await _resolve_runtime_agent_id(session, gateway_id, agent_id)
    payload = await _call_or_502(
        "agents.files.list", {"agentId": runtime_id}, config=config,
    )
    files: list[AgentFileEntry] = []
    workspace: str | None = None
    if isinstance(payload, dict):
        if isinstance(payload.get("workspace"), str):
            workspace = payload["workspace"]
        raw_files = payload.get("files")
        if isinstance(raw_files, list):
            for item in raw_files:
                if not isinstance(item, dict):
                    continue
                name = item.get("name") or item.get("path")
                if not isinstance(name, str):
                    continue
                files.append(
                    AgentFileEntry(
                        name=name,
                        path=item.get("path") if isinstance(item.get("path"), str) else None,
                        size=item.get("size") if isinstance(item.get("size"), int) else None,
                        updated_at=_parse_dt(item.get("updatedAt") or item.get("mtime")),
                        missing=item.get("missing") if isinstance(item.get("missing"), bool) else None,
                    ),
                )
    return AgentFilesListResponse(
        agent_id=runtime_id, workspace=workspace, files=files,
    )


@router.get(
    "/{gateway_id}/agents/{agent_id}/files/{file_name:path}",
    response_model=AgentFileContentResponse,
)
async def get_agent_file(
    gateway_id: UUID,
    agent_id: UUID,
    file_name: str,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> AgentFileContentResponse:
    """Fetch a single workspace file's contents (`agents.files.get` RPC)."""
    config = await _resolve_config(gateway_id, session, auth, ctx)
    runtime_id = await _resolve_runtime_agent_id(session, gateway_id, agent_id)
    payload = await _call_or_502(
        "agents.files.get",
        {"agentId": runtime_id, "name": file_name},
        config=config,
    )
    content = ""
    size: int | None = None
    if isinstance(payload, dict):
        if isinstance(payload.get("content"), str):
            content = payload["content"]
        if isinstance(payload.get("size"), int):
            size = payload["size"]
    return AgentFileContentResponse(
        agent_id=runtime_id, name=file_name, content=content, size=size,
    )


@router.put(
    "/{gateway_id}/agents/{agent_id}/files/{file_name:path}",
    response_model=AgentFileContentResponse,
)
async def set_agent_file(
    gateway_id: UUID,
    agent_id: UUID,
    file_name: str,
    body: AgentFileWriteRequest,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> AgentFileContentResponse:
    """Write a workspace file (`agents.files.set` RPC).

    This is the operator-facing memory editor. Unlike the candidate's
    template-sync flow (which renders mustache templates and writes them),
    this endpoint accepts raw content and writes it as-is. Intended for
    direct edits to BOOTSTRAP/SOUL/IDENTITY/etc. on imported agents whose
    templates the candidate doesn't own.
    """
    config = await _resolve_config(gateway_id, session, auth, ctx)
    runtime_id = await _resolve_runtime_agent_id(session, gateway_id, agent_id)
    await _call_or_502(
        "agents.files.set",
        {"agentId": runtime_id, "name": file_name, "content": body.content},
        config=config,
    )
    return AgentFileContentResponse(
        agent_id=runtime_id, name=file_name, content=body.content,
        size=len(body.content.encode("utf-8")),
    )
