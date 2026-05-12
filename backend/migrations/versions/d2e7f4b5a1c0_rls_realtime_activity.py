"""rls policies for realtime activity feed

Revision ID: d2e7f4b5a1c0
Revises: c1a8e5d7b9e3
Create Date: 2026-05-12 21:00:00.000000

The candidate enables RLS on all 30 public tables at create-time but ships
zero policies. Net effect: `anon` and `authenticated` roles are denied
everything (default deny), and only `service_role` (backend) can read/write.
That's the most secure baseline for a backend-mediated app.

This migration adds the *minimum* SELECT policy needed so the Supabase
Realtime channel can deliver activity events to logged-in users without
exposing more than what the FastAPI `/api/v1/activity` endpoint would
already return. Specifically:

- `authenticated` users may SELECT any `activity_events` row, but only if
  they themselves have a row in `public.users` keyed by the JWT subject
  (i.e. they completed the `_get_or_sync_user` upsert in `app.core.auth`).

For a multi-org deployment this policy would need to scope by org via
`board_id → boards.organization_id → organization_members.user_id =
public.users.id`. We deliberately don't add that join here because:
  1. The current deployment is single-operator / single-org;
  2. `activity_events.board_id` is nullable (system-wide events) and the
     join would silently hide those entries from Realtime;
  3. The backend remains the source of truth for org scoping — RLS is
     defense-in-depth.

If/when multi-org rolls out, replace this policy with the joined version.
"""

from __future__ import annotations

from alembic import op


# revision identifiers, used by Alembic.
revision = "d2e7f4b5a1c0"
down_revision = "c1a8e5d7b9e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SELECT for authenticated. Uses a `EXISTS` subquery rather than a join
    # so Realtime row-broadcast keeps the cost O(1) per event.
    op.execute(
        """
        CREATE POLICY activity_events_authenticated_select
        ON public.activity_events
        FOR SELECT
        TO authenticated
        USING (
            EXISTS (
                SELECT 1 FROM public.users u
                WHERE u.clerk_user_id = auth.uid()::text
            )
        );
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP POLICY IF EXISTS activity_events_authenticated_select "
        "ON public.activity_events;"
    )
