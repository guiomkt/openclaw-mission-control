"""add is_gateway_managed to agents

Revision ID: c1a8e5d7b9e3
Revises: a9b1c2d3e4f7
Create Date: 2026-05-12 20:00:00.000000

Adds a boolean column `is_gateway_managed` to `public.agents`. When True, the
candidate's provisioning / drift loops (sync_gateway_templates,
ensure_main_agent, lifecycle_reconcile) skip the row — used for agents
imported from a pre-existing OpenClaw deployment whose templates / heartbeat
config the operator maintains directly on the gateway side.

Existing rows get `False` (the candidate's default) so historical
synthetic Gateway Agents continue to be managed.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "c1a8e5d7b9e3"
down_revision = "a9b1c2d3e4f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "is_gateway_managed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    # Index supports the drift detector's "list all gateway-managed agents
    # for gateway X" query which runs every 5 minutes per Phase E.
    op.create_index(
        "ix_agents_is_gateway_managed",
        "agents",
        ["is_gateway_managed"],
    )


def downgrade() -> None:
    op.drop_index("ix_agents_is_gateway_managed", table_name="agents")
    op.drop_column("agents", "is_gateway_managed")
