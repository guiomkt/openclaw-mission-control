"""Periodic drift detection between mc-v2 `agents` table and gateway runtime.

For every gateway in the DB, we:
  1. Call `agents.list` on the gateway over WebSocket RPC.
  2. Diff the runtime keys against mc-v2's `agents` table (filtered by
     `is_gateway_managed=true`).
  3. Record an `activity_events` row for any newly-detected drift —
     - new runtime agents that mc-v2 doesn't yet know about, OR
     - mc-v2 rows whose runtime counterpart vanished.

The event_type tag is `gateway.drift.detected`. The frontend reads recent
drift events to show a banner on `/gateways/[gatewayId]/` ("Drift detected:
N agents differ — re-sync?").

This is intentionally a *detection-only* job. Re-synchronisation requires
the operator's intent (via the existing `POST /api/v1/gateways/{id}/discover`
endpoint with `?reconcile=true` in a future change), because gateway-side
edits may be intentional and auto-reconciliation would silently overwrite
operator changes.

Schedule: every 5 minutes from the RQ scheduler. Idempotent — if no drift
deltas vs. the previous run, no new activity_events are written.
"""

from __future__ import annotations

import json
from typing import Any

from sqlmodel import col

from app.core.logging import get_logger
from app.core.time import utcnow
from app.db.session import async_session_maker
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.gateways import Gateway
from app.services.openclaw.gateway_rpc import (
    GatewayConfig as GatewayClientConfig,
    OpenClawGatewayError,
    openclaw_call,
)

logger = get_logger(__name__)


async def detect_gateway_drift_once() -> dict[str, Any]:
    """Run one drift-detection pass over every gateway. Returns a summary."""
    summary: dict[str, Any] = {
        "gateways_checked": 0,
        "events_written": 0,
        "errors": [],
    }

    async with async_session_maker() as session:
        gateways = await Gateway.objects.all().all(session)
        for gateway in gateways:
            if not gateway.url:
                continue
            summary["gateways_checked"] += 1
            try:
                payload = await openclaw_call(
                    "agents.list",
                    None,
                    config=GatewayClientConfig(
                        url=gateway.url,
                        token=gateway.token,
                        allow_insecure_tls=gateway.allow_insecure_tls,
                        disable_device_pairing=gateway.disable_device_pairing,
                    ),
                )
            except OpenClawGatewayError as exc:
                logger.warning(
                    "drift_detector.gateway_unreachable gateway_id=%s reason=%s",
                    gateway.id,
                    exc,
                )
                summary["errors"].append({"gateway_id": str(gateway.id), "reason": str(exc)})
                continue

            runtime_session_keys: set[str] = set()
            if isinstance(payload, dict):
                raw = payload.get("agents")
                if isinstance(raw, list):
                    for item in raw:
                        if not isinstance(item, dict):
                            continue
                        rid = item.get("id")
                        if isinstance(rid, str) and rid:
                            runtime_session_keys.add(f"agent:{rid}:main")

            db_rows = await (
                Agent.objects.filter_by(gateway_id=gateway.id)
                .filter(col(Agent.is_gateway_managed).is_(True))
                .all(session)
            )
            db_session_keys = {
                row.openclaw_session_id
                for row in db_rows
                if row.openclaw_session_id
            }

            in_runtime_only = runtime_session_keys - db_session_keys
            in_db_only = db_session_keys - runtime_session_keys

            if not in_runtime_only and not in_db_only:
                continue

            # De-dupe: skip if the most recent drift event for this gateway
            # already reports the same delta. Keeps the activity feed quiet
            # when the operator is sitting on a known drift without
            # resolving it.
            latest = await (
                ActivityEvent.objects.all()
                .filter(col(ActivityEvent.event_type) == "gateway.drift.detected")
                .order_by(col(ActivityEvent.created_at).desc())
                .first(session)
            )
            new_payload = {
                "gateway_id": str(gateway.id),
                "in_runtime_only": sorted(in_runtime_only),
                "in_db_only": sorted(in_db_only),
            }
            if (
                latest is not None
                and latest.message
                and _safe_json_equal(latest.message, new_payload)
            ):
                continue

            event = ActivityEvent(
                event_type="gateway.drift.detected",
                message=json.dumps(new_payload),
                created_at=utcnow(),
            )
            session.add(event)
            summary["events_written"] += 1

        if summary["events_written"]:
            await session.commit()

    logger.info(
        "drift_detector.run gateways_checked=%s events_written=%s errors=%s",
        summary["gateways_checked"],
        summary["events_written"],
        len(summary["errors"]),
    )
    return summary


def _safe_json_equal(left: str, right: dict[str, Any]) -> bool:
    try:
        return json.loads(left) == right
    except (json.JSONDecodeError, TypeError):
        return False
