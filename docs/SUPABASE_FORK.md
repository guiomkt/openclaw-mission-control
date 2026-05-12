# Supabase Auth + Storage fork

This branch (`feat/supabase-auth-storage` on `guiomkt/openclaw-mission-control`)
adapts `abhi1693/openclaw-mission-control` to run against **Supabase Cloud**
instead of the bundled Postgres + Clerk/local-token combo.

Upstream pin: `75eb8b0894803e48891a8a92b564c25fb126f2ea` (master, 2026-04-04).

## What changed vs upstream

### Backend (FastAPI)
- `app/core/auth_mode.py` — added `AuthMode.SUPABASE`.
- `app/core/config.py` — new fields:
  `supabase_url`, `supabase_jwt_secret`, `supabase_service_role_key`,
  `supabase_leeway`, `gateway_token_encryption_key`. Validator rejects
  missing `SUPABASE_JWT_SECRET` or `GATEWAY_TOKEN_ENCRYPTION_KEY` when
  `AUTH_MODE=supabase`.
- `app/core/auth.py` — new `_authenticate_supabase_request()` + helper
  `_decode_supabase_token()` (HS256 via PyJWT, `aud="authenticated"`,
  `exp+sub` required). `_get_or_sync_user()` no longer calls the Clerk
  profile API outside Clerk mode. Supabase `sub` is stored in the existing
  `users.clerk_user_id` column (column name predates this provider).
- `app/db/encrypted_str.py` — new SQLAlchemy `TypeDecorator` that
  Fernet-encrypts string columns at rest, keyed from
  `GATEWAY_TOKEN_ENCRYPTION_KEY`.
- `app/models/gateways.py` — `Gateway.token` now uses `EncryptedStr` so
  OpenClaw gateway secrets are encrypted in Supabase Postgres.
- `pyproject.toml` — added `pyjwt==2.11.0` as a direct dependency.

No Alembic migration: the column type swap is transparent to Postgres
(stored type is still TEXT); empty rows on first deploy mean there's no
seed data to re-encrypt.

### Frontend (Next.js)
- `auth/mode.ts` — `AuthMode.Supabase` added.
- `auth/localAuth.ts` — `isSupabaseAuthMode()` helper.
- `auth/supabaseClient.ts` — singleton browser client.
- `auth/SupabaseAuthContext.tsx` — React Context with the session
  subscription + `getToken()` (always fresh, not stale by the refresh
  cycle).
- `components/providers/AuthProvider.tsx` — branches on Supabase mode,
  mounts `SupabaseAuthProvider` + a `SupabaseAuthGate` that blocks the
  tree on missing session.
- `components/organisms/SupabaseLogin.tsx` — email/password sign-in
  surface for the gate.
- `auth/clerk.tsx` — keeps its name (so 40+ call sites stay untouched)
  but now also dispatches into the Supabase code path inside
  `useAuth`/`useUser`/`SignedIn`/`SignedOut`.
- `package.json` — added `@supabase/supabase-js`.

### Compose / Dockerfiles / env
- `compose.yml` — removed `db` (Postgres) service; bound `backend` and
  `frontend` to `127.0.0.1`; defaulted `DB_AUTO_MIGRATE=false`; plumbed
  every Supabase env var (`SUPABASE_*` for backend, `NEXT_PUBLIC_SUPABASE_*`
  for frontend build args + runtime).
- `frontend/Dockerfile` — added `ARG`/`ENV` for `NEXT_PUBLIC_SUPABASE_URL`
  and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (must be baked at build time).
- `.env.example` — rewritten for Supabase mode.

## Operator checklist

Before bringing the stack up:

1. Create a Supabase Cloud project. Capture URL + anon + service_role +
   JWT secret + the pooler `DATABASE_URL` (port 6543).
2. Generate `GATEWAY_TOKEN_ENCRYPTION_KEY` with
   `openssl rand -base64 32`.
3. Populate `.env` from `.env.example`.
4. `docker compose up -d --build`.
5. `docker compose exec backend alembic upgrade head` (since
   `DB_AUTO_MIGRATE=false`).
6. Sign in via the Supabase login page; complete the in-app onboarding to
   create the operator's organization.
7. Add the OpenClaw gateway from the Gateways module; the entered token
   gets Fernet-encrypted before insert.

## Known limitations

- The `users.clerk_user_id` column name predates Supabase mode. Rename
  to `external_user_id` in a follow-up if multi-provider becomes a need.
- `@clerk/nextjs` is still in `package.json` (used by the Clerk-mode
  code path that remains intact for upstream compatibility). It adds
  ~100KB to the bundle in Supabase mode but is never called at runtime.
- `pgcrypto` is not used; encryption happens application-side. Re-keying
  requires a batch re-encryption script (not yet provided — only needed
  when actual gateway secrets are seeded).
