"""Gateway admin lifecycle service."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING
from uuid import UUID

from fastapi import HTTPException, status
from sqlmodel import col

from app.core.auth import AuthContext
from app.core.logging import TRACE_LEVEL
from app.core.time import utcnow
from app.db import crud
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.approvals import Approval
from app.models.board_webhooks import BoardWebhook
from app.models.gateways import Gateway
from app.models.tasks import Task
from app.schemas.gateways import (
    GatewayDiscoveredAgent,
    GatewayDiscoveryResult,
    GatewayTemplatesSyncResult,
)
from app.services.openclaw.constants import DEFAULT_HEARTBEAT_CONFIG
from app.services.openclaw.db_service import OpenClawDBService
from app.services.openclaw.error_messages import normalize_gateway_error_message
from app.services.openclaw.gateway_compat import check_gateway_version_compatibility
from app.services.openclaw.gateway_rpc import GatewayConfig as GatewayClientConfig
from app.services.openclaw.gateway_rpc import OpenClawGatewayError, openclaw_call
from app.services.openclaw.lifecycle_orchestrator import AgentLifecycleOrchestrator
from app.services.openclaw.provisioning_db import (
    GatewayTemplateSyncOptions,
    OpenClawProvisioningService,
)
from app.services.openclaw.session_service import GatewayTemplateSyncQuery
from app.services.openclaw.shared import GatewayAgentIdentity

if TYPE_CHECKING:
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app.models.users import User


class AbstractGatewayMainAgentManager(ABC):
    """Abstract manager for gateway-main agent naming/profile behavior."""

    @abstractmethod
    def build_main_agent_name(self, gateway: Gateway) -> str:
        raise NotImplementedError

    @abstractmethod
    def build_identity_profile(self) -> dict[str, str]:
        raise NotImplementedError


class DefaultGatewayMainAgentManager(AbstractGatewayMainAgentManager):
    """Default naming/profile strategy for gateway-main agents."""

    def build_main_agent_name(self, gateway: Gateway) -> str:
        return f"{gateway.name} Gateway Agent"

    def build_identity_profile(self) -> dict[str, str]:
        return {
            "role": "Gateway Agent",
            "communication_style": "direct, concise, practical",
            "emoji": ":compass:",
        }


class GatewayAdminLifecycleService(OpenClawDBService):
    """Write-side gateway lifecycle service (CRUD, main agent, template sync)."""

    def __init__(
        self,
        session: AsyncSession,
        *,
        main_agent_manager: AbstractGatewayMainAgentManager | None = None,
    ) -> None:
        super().__init__(session)
        self._main_agent_manager = main_agent_manager or DefaultGatewayMainAgentManager()

    @property
    def main_agent_manager(self) -> AbstractGatewayMainAgentManager:
        return self._main_agent_manager

    @main_agent_manager.setter
    def main_agent_manager(self, value: AbstractGatewayMainAgentManager) -> None:
        self._main_agent_manager = value

    async def require_gateway(
        self,
        *,
        gateway_id: UUID,
        organization_id: UUID,
    ) -> Gateway:
        gateway = (
            await Gateway.objects.by_id(gateway_id)
            .filter(col(Gateway.organization_id) == organization_id)
            .first(self.session)
        )
        if gateway is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Gateway not found",
            )
        return gateway

    async def find_main_agent(self, gateway: Gateway) -> Agent | None:
        return (
            await Agent.objects.filter_by(gateway_id=gateway.id)
            .filter(col(Agent.board_id).is_(None))
            .first(self.session)
        )

    async def upsert_main_agent_record(self, gateway: Gateway) -> tuple[Agent, bool]:
        changed = False
        session_key = GatewayAgentIdentity.session_key(gateway)
        agent = await self.find_main_agent(gateway)
        main_agent_name = self.main_agent_manager.build_main_agent_name(gateway)
        identity_profile = self.main_agent_manager.build_identity_profile()
        if agent is None:
            agent = Agent(
                name=main_agent_name,
                status="provisioning",
                board_id=None,
                gateway_id=gateway.id,
                is_board_lead=False,
                openclaw_session_id=session_key,
                heartbeat_config=DEFAULT_HEARTBEAT_CONFIG.copy(),
                identity_profile=identity_profile,
            )
            self.session.add(agent)
            changed = True
        if agent.board_id is not None:
            agent.board_id = None
            changed = True
        if agent.gateway_id != gateway.id:
            agent.gateway_id = gateway.id
            changed = True
        if agent.is_board_lead:
            agent.is_board_lead = False
            changed = True
        if agent.name != main_agent_name:
            agent.name = main_agent_name
            changed = True
        if agent.openclaw_session_id != session_key:
            agent.openclaw_session_id = session_key
            changed = True
        if agent.heartbeat_config is None:
            agent.heartbeat_config = DEFAULT_HEARTBEAT_CONFIG.copy()
            changed = True
        if agent.identity_profile is None:
            agent.identity_profile = identity_profile
            changed = True
        if not agent.status:
            agent.status = "provisioning"
            changed = True
        if changed:
            agent.updated_at = utcnow()
            self.session.add(agent)
        return agent, changed

    async def gateway_has_main_agent_entry(self, gateway: Gateway) -> bool:
        if not gateway.url:
            return False
        config = GatewayClientConfig(
            url=gateway.url,
            token=gateway.token,
            allow_insecure_tls=gateway.allow_insecure_tls,
            disable_device_pairing=gateway.disable_device_pairing,
        )
        target_id = GatewayAgentIdentity.openclaw_agent_id(gateway)
        try:
            await openclaw_call("agents.files.list", {"agentId": target_id}, config=config)
        except OpenClawGatewayError as exc:
            message = str(exc).lower()
            if any(marker in message for marker in ("not found", "unknown agent", "no such agent")):
                return False
            return True
        return True

    async def assert_gateway_runtime_compatible(
        self,
        *,
        url: str,
        token: str | None,
        allow_insecure_tls: bool = False,
        disable_device_pairing: bool = False,
    ) -> None:
        """Validate that a gateway runtime meets minimum supported version."""
        config = GatewayClientConfig(
            url=url,
            token=token,
            allow_insecure_tls=allow_insecure_tls,
            disable_device_pairing=disable_device_pairing,
        )
        try:
            result = await check_gateway_version_compatibility(config)
        except OpenClawGatewayError as exc:
            detail = normalize_gateway_error_message(str(exc))
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Gateway compatibility check failed: {detail}",
            ) from exc
        if not result.compatible:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=result.message or "Gateway runtime version is not supported.",
            )

    async def provision_main_agent_record(
        self,
        gateway: Gateway,
        agent: Agent,
        *,
        user: User | None,
        action: str,
        notify: bool,
    ) -> Agent:
        orchestrator = AgentLifecycleOrchestrator(self.session)
        try:
            provisioned = await orchestrator.run_lifecycle(
                gateway=gateway,
                agent_id=agent.id,
                board=None,
                user=user,
                action=action,
                auth_token=None,
                force_bootstrap=False,
                reset_session=False,
                wake=notify,
                deliver_wakeup=True,
                wakeup_verb=None,
                clear_confirm_token=False,
                raise_gateway_errors=True,
            )
        except HTTPException:
            self.logger.error(
                "gateway.main_agent.provision_failed gateway_id=%s agent_id=%s action=%s",
                gateway.id,
                agent.id,
                action,
            )
            raise
        self.logger.info(
            "gateway.main_agent.provision_success gateway_id=%s agent_id=%s action=%s",
            gateway.id,
            provisioned.id,
            action,
        )
        return provisioned

    async def ensure_main_agent(
        self,
        gateway: Gateway,
        auth: AuthContext,
        *,
        action: str = "provision",
    ) -> Agent:
        self.logger.log(
            TRACE_LEVEL,
            "gateway.main_agent.ensure.start gateway_id=%s action=%s",
            gateway.id,
            action,
        )
        agent, _ = await self.upsert_main_agent_record(gateway)
        return await self.provision_main_agent_record(
            gateway,
            agent,
            user=auth.user,
            action=action,
            notify=True,
        )

    async def discover_runtime_agents(
        self,
        gateway: Gateway,
        *,
        create_board: bool = False,
    ) -> GatewayDiscoveryResult:
        """Discover existing OpenClaw agents on a gateway and import them.

        Calls the gateway's `agents.list` RPC, then upserts a row in
        `public.agents` per runtime agent. Imported rows are flagged with
        `is_gateway_managed=True` so the candidate's provisioning loops
        (templates sync, lifecycle reconcile) skip them — the operator owns
        the gateway-side config for these agents.

        Drift handling: agents present in mc-v2 (with `is_gateway_managed=True`
        and `openclaw_session_id` matching the `agent:{id}:main` shape) but
        missing from the runtime are returned in `drift_in_db_only` for the
        UI to surface. We do NOT auto-delete drifted rows — the operator
        decides.

        Args:
            gateway: target gateway (must already exist in `public.gateways`).
            create_board: when True and no board references `gateway.id`,
                create a default "OpenClaw operations" board so the operator
                lands on something useful after onboarding.

        Returns:
            `GatewayDiscoveryResult` summarising discovered/imported/matched
            counts plus drift and the optional bootstrap board id.
        """
        if not gateway.url:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Gateway has no url; cannot discover runtime agents.",
            )
        config = GatewayClientConfig(
            url=gateway.url,
            token=gateway.token,
            allow_insecure_tls=gateway.allow_insecure_tls,
            disable_device_pairing=gateway.disable_device_pairing,
        )
        try:
            payload = await openclaw_call("agents.list", config=config)
        except OpenClawGatewayError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Gateway discovery failed: {normalize_gateway_error_message(str(exc))}",
            ) from exc

        runtime_agents: list[dict[str, object]] = []
        if isinstance(payload, dict):
            raw_list = payload.get("agents")
            if isinstance(raw_list, list):
                runtime_agents = [entry for entry in raw_list if isinstance(entry, dict)]

        # Index existing rows by openclaw_session_id so we can do O(1) lookup
        # while iterating runtime entries. The session_key shape is
        # `agent:{runtime_id}:main` — same for imported agents and for the
        # synthetic gateway main agent (its runtime_id is `mc-gateway-<uuid>`).
        existing_rows: list[Agent] = await (
            Agent.objects.filter_by(gateway_id=gateway.id).all(self.session)
        )
        existing_by_session_key: dict[str, Agent] = {
            row.openclaw_session_id: row
            for row in existing_rows
            if row.openclaw_session_id
        }

        discovered_runtime_keys: set[str] = set()
        result_agents: list[GatewayDiscoveredAgent] = []
        imported_count = 0
        matched_count = 0

        for entry in runtime_agents:
            runtime_id_raw = entry.get("id")
            if not isinstance(runtime_id_raw, str) or not runtime_id_raw:
                continue
            runtime_id = runtime_id_raw
            session_key = f"agent:{runtime_id}:main"
            discovered_runtime_keys.add(session_key)
            name = entry.get("name") if isinstance(entry.get("name"), str) else None
            display_name = name or runtime_id
            workspace = entry.get("workspace") if isinstance(entry.get("workspace"), str) else None
            agent_runtime = None
            ar = entry.get("agentRuntime")
            if isinstance(ar, dict) and isinstance(ar.get("id"), str):
                agent_runtime = ar["id"]
            model_primary = None
            model_block = entry.get("model")
            if isinstance(model_block, dict) and isinstance(model_block.get("primary"), str):
                model_primary = model_block["primary"]
            elif isinstance(model_block, str):
                model_primary = model_block
            heartbeat_cfg = entry.get("heartbeat") if isinstance(entry.get("heartbeat"), dict) else None
            identity = entry.get("identity") if isinstance(entry.get("identity"), dict) else None

            existing = existing_by_session_key.get(session_key)
            if existing is not None:
                # Refresh display name + identity from the runtime so the UI
                # reflects gateway-side renames without a full re-import.
                changed = False
                if name and existing.name != name:
                    existing.name = name
                    changed = True
                if heartbeat_cfg and existing.heartbeat_config != heartbeat_cfg:
                    existing.heartbeat_config = heartbeat_cfg
                    changed = True
                if identity and existing.identity_profile != identity:
                    existing.identity_profile = identity
                    changed = True
                if not existing.is_gateway_managed:
                    # Pre-existing row that we now recognise as gateway-managed
                    # (e.g. a previously hand-created mirror). Flip the flag so
                    # provisioning loops stop touching it.
                    existing.is_gateway_managed = True
                    changed = True
                if changed:
                    existing.updated_at = utcnow()
                    self.session.add(existing)
                matched_count += 1
                result_agents.append(
                    GatewayDiscoveredAgent(
                        runtime_id=runtime_id,
                        name=display_name,
                        workspace=workspace,
                        agent_runtime=agent_runtime,
                        model_primary=model_primary,
                        is_new=False,
                        agent_id=existing.id,
                    ),
                )
                continue

            # New row. Note: board_id is None on import — operator assigns
            # later via /agents/[id]/edit. status="online" because the agent
            # is already running on the gateway; mc-v2 doesn't need to
            # provision it.
            new_agent = Agent(
                name=display_name,
                status="online",
                board_id=None,
                gateway_id=gateway.id,
                openclaw_session_id=session_key,
                heartbeat_config=heartbeat_cfg,
                identity_profile=identity,
                is_board_lead=False,
                is_gateway_managed=True,
            )
            self.session.add(new_agent)
            await self.session.flush()
            imported_count += 1
            result_agents.append(
                GatewayDiscoveredAgent(
                    runtime_id=runtime_id,
                    name=display_name,
                    workspace=workspace,
                    agent_runtime=agent_runtime,
                    model_primary=model_primary,
                    is_new=True,
                    agent_id=new_agent.id,
                ),
            )

        # Drift: rows in DB flagged as gateway-managed but whose session key
        # is no longer present in the runtime. The synthetic mc-gateway main
        # agent is NOT in this set (its is_gateway_managed stays False).
        drift_in_db_only: list[UUID] = [
            row.id
            for row in existing_rows
            if row.is_gateway_managed
            and row.openclaw_session_id
            and row.openclaw_session_id not in discovered_runtime_keys
        ]

        bootstrap_board_id: UUID | None = None
        if create_board:
            # Local import keeps the admin_service module free of board imports
            # for the non-bootstrap case (most calls).
            from app.models.boards import Board

            existing_board = await Board.objects.filter_by(gateway_id=gateway.id).first(
                self.session,
            )
            if existing_board is None:
                # slug must be NOT NULL + unique within the org; derive from
                # the gateway name with a short suffix so re-discoveries
                # against multiple gateways don't collide on the same org.
                board_slug = f"openclaw-{gateway.id.hex[:8]}"
                board = Board(
                    name="OpenClaw operations",
                    slug=board_slug,
                    description=(
                        "Default board created on first agent discovery. "
                        "Use it to track tasks across imported agents."
                    ),
                    gateway_id=gateway.id,
                    organization_id=gateway.organization_id,
                )
                self.session.add(board)
                await self.session.flush()
                bootstrap_board_id = board.id

        await self.session.commit()

        self.logger.info(
            "gateway.discovery.complete gateway_id=%s discovered=%s imported=%s "
            "matched=%s drift_in_db_only=%s",
            gateway.id,
            len(runtime_agents),
            imported_count,
            matched_count,
            len(drift_in_db_only),
        )

        return GatewayDiscoveryResult(
            gateway_id=gateway.id,
            discovered=len(runtime_agents),
            imported=imported_count,
            matched=matched_count,
            drift_in_db_only=drift_in_db_only,
            agents=result_agents,
            bootstrap_board_id=bootstrap_board_id,
        )

    async def ensure_gateway_agents_exist(self, gateways: list[Gateway]) -> None:
        for gateway in gateways:
            agent, gateway_changed = await self.upsert_main_agent_record(gateway)
            has_gateway_entry = await self.gateway_has_main_agent_entry(gateway)
            needs_provision = (
                gateway_changed or not bool(agent.agent_token_hash) or not has_gateway_entry
            )
            if needs_provision:
                await self.provision_main_agent_record(
                    gateway,
                    agent,
                    user=None,
                    action="provision",
                    notify=False,
                )

    async def clear_agent_foreign_keys(self, *, agent_id: UUID) -> None:
        now = utcnow()
        await crud.update_where(
            self.session,
            Task,
            col(Task.assigned_agent_id) == agent_id,
            col(Task.status) == "in_progress",
            assigned_agent_id=None,
            status="inbox",
            in_progress_at=None,
            updated_at=now,
            commit=False,
        )
        await crud.update_where(
            self.session,
            Task,
            col(Task.assigned_agent_id) == agent_id,
            col(Task.status) != "in_progress",
            assigned_agent_id=None,
            updated_at=now,
            commit=False,
        )
        await crud.update_where(
            self.session,
            ActivityEvent,
            col(ActivityEvent.agent_id) == agent_id,
            agent_id=None,
            commit=False,
        )
        await crud.update_where(
            self.session,
            Approval,
            col(Approval.agent_id) == agent_id,
            agent_id=None,
            commit=False,
        )
        await crud.update_where(
            self.session,
            BoardWebhook,
            col(BoardWebhook.agent_id) == agent_id,
            agent_id=None,
            updated_at=now,
            commit=False,
        )

    async def sync_templates(
        self,
        gateway: Gateway,
        *,
        query: GatewayTemplateSyncQuery,
        auth: AuthContext,
    ) -> GatewayTemplatesSyncResult:
        self.logger.log(
            TRACE_LEVEL,
            "gateway.templates.sync.start gateway_id=%s include_main=%s",
            gateway.id,
            query.include_main,
        )
        await self.ensure_gateway_agents_exist([gateway])
        result = await OpenClawProvisioningService(self.session).sync_gateway_templates(
            gateway,
            GatewayTemplateSyncOptions(
                user=auth.user,
                include_main=query.include_main,
                lead_only=query.lead_only,
                reset_sessions=query.reset_sessions,
                rotate_tokens=query.rotate_tokens,
                force_bootstrap=query.force_bootstrap,
                overwrite=query.overwrite,
                board_id=query.board_id,
            ),
        )
        self.logger.info("gateway.templates.sync.success gateway_id=%s", gateway.id)
        return result
