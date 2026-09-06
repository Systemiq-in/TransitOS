# TransitOS

School-transport operating system for Indian schools. See `docs/superpowers/specs/`
for the design specs and `docs/superpowers/plans/` for implementation plans.

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for Postgres + Redis locally)

## First-time setup

1. Copy the environment template and fill in real values:
   ```bash
   cp .env.example .env
   # Generate JWT_SECRET:        openssl rand -base64 48
   # Generate MFA_ENCRYPTION_KEY: openssl rand -hex 32
   ```
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Start Postgres and Redis:
   ```bash
   docker compose up -d
   ```
   
   **Note on Docker Compose versions:** The command above uses Docker Compose V2 (recommended).
   If you have the legacy `docker-compose` v1 installed instead and see `Not supported URL scheme http+docker`,
   run `docker-compose up -d` instead, or use the fallback:
   ```bash
   docker run -d --name transitos-pg \
     -e POSTGRES_USER=transitos_migrator \
     -e POSTGRES_PASSWORD=devpassword \
     -e POSTGRES_DB=transitos \
     -p 55432:5432 \
     postgres:16
   ```

4. Export the variables from `.env` into your shell (or use a tool like `direnv`),
   then create the application's database role:
   ```bash
   set -a && source .env && set +a
   pnpm --filter @transitos/api db:bootstrap
   ```
   
   **Note:** Verify your `.env` has `DATABASE_URL` and `DATABASE_MIGRATION_URL` pointing to
   port **55432** (not 5432), matching the `docker-compose.yml` mapping `["55432:5432"]`.
   The `.env.example` template already has this configured.
5. Run migrations:
   ```bash
   pnpm --filter @transitos/api migration:run
   ```
6. Seed the first super_admin:
   ```bash
   SEED_SUPER_ADMIN_EMAIL=you@example.com SEED_SUPER_ADMIN_PASSWORD='Correct-Horse9!' \
     pnpm --filter @transitos/api seed
   ```
7. Start the API:
   ```bash
   pnpm --filter @transitos/api start:dev
   ```

The API will be available at `http://localhost:3000`. Test with:
```bash
curl http://localhost:3000/healthz
```

## Running tests

```bash
# Unit + integration tests (requires Postgres running and migrated)
pnpm --filter @transitos/api test

# End-to-end HTTP tests (same requirement)
pnpm --filter @transitos/api test:e2e

# Linting
pnpm --filter @transitos/api lint
```

CI (`.github/workflows/ci.yml`) runs all of the above against a fresh Postgres
service container on every push.

## API overview

### Authentication

- `POST /auth/login` — Log in with `emailOrPhone` + password
- `POST /auth/refresh` — Refresh an access token
- `POST /auth/logout` — Log out the current session
- `POST /auth/logout-all` — Log out all sessions
- `POST /auth/mfa/setup` — Enroll in MFA, returns QR code and secret
- `POST /auth/mfa/confirm` — Confirm MFA enrollment with TOTP code
- `POST /auth/mfa/verify` — Verify MFA code on login

### Users & Schools

- `GET /users/me` — Get the current user profile
- `GET /schools` — List schools (paginated)
- `POST /schools` — Create a school with `name` field (super_admin only)
- `GET /schools/:id` — Get a school by id
- `GET /schools/:id/users` — List users for a school (paginated, school_admin+ only)
- `POST /schools/:id/users` — Add a user to a school (super_admin/school_admin only)

### Health & Admin

- `GET /healthz` — Health check (no auth required)

All list endpoints return paginated results in the format:
```json
{
  "success": true,
  "data": {
    "items": [...],
    "total": 42,
    "limit": 10,
    "offset": 0
  }
}
```

## Acceptance verification

The README above documents the complete setup path. To verify it works:

1. **API is running** at http://localhost:3000 with all endpoints mapped
2. **Seeded super_admin can log in** with the email/password from step 6
3. **Create and manage tenants** by creating schools and school_admin users
4. **Access control enforced** — school_admin can only see their own school's users (403 for others)
5. **MFA enrollment works** — `/auth/mfa/setup` returns a TOTP secret
6. **Session management** — `/auth/logout` and `/auth/logout-all` revoke sessions
7. **Audit logging enforced** — app role cannot UPDATE audit logs due to database permissions
8. **All tests pass** — run the three test commands separately:
   ```bash
   pnpm --filter @transitos/api test
   pnpm --filter @transitos/api test:e2e
   pnpm --filter @transitos/api lint
   ```

## What's here

This is **Sub-project 1: Foundations** — the auth/tenancy substrate every later
sub-project builds on. This sub-project provides:

- Multi-tenant identity with role-based access control (super_admin, school_admin, driver, attendant, parent)
- MFA enrollment and verification
- Session management (login, logout, token refresh)
- Audit logging for tenant and user creation (`school.created`, `user.created`) and for session events (`user.login`, `user.logout`, `user.logout_all`) — not yet every mutating operation; later sub-projects extend this coverage as they add endpoints
- Database-level row-level security (RLS) enforcing tenancy boundaries

See `docs/superpowers/specs/2026-09-05-foundations-design.md` for the full design
and what this sub-project deliberately **does not** cover (no students, vehicles,
routes, trips, GPS, payments, or notifications — those come in later sub-projects).

See `docs/superpowers/specs/engineering-standards.md` for the security and privacy
standards the whole platform is held to.

## Architecture

See `docs/ARCHITECTURE.md` for system design, data flow, and deployment model.

## Development workflow

See `docs/PROJECT-REQUIREMENTS.md` for the full project requirements and acceptance criteria.

See `docs/SESSION-HANDOFF.md` for implementation notes, known issues, and areas for future improvement.
