# TransitOS — Sub-project 1: Foundations — Design Spec

Status: Approved for planning (amended 2026-09-05 to align with
`engineering-standards.md`)
Date: 2026-09-05
Depends on: nothing (first sub-project)
Governed by: `engineering-standards.md` §1–4, §8–9 apply directly to this
sub-project; see that doc for what's deferred to later ones.
Followed by: Sub-project 2 — Core transport backend + Admin web (schools, students,
guardians, vehicles, drivers, routes/stops, trip state machine)

## 1. Purpose

TransitOS is a school-transport operating system (see `../../../idea.md` for full
market/product research). It will eventually comprise an admin web portal, a parent
mobile app, a driver/attendant mobile app, a realtime GPS pipeline, a fee/payments
engine, and a notifications/compliance system, serving many schools (tenants) from one
platform.

Building all of that at once is not viable. This spec covers only the **substrate**
every later sub-project builds on: repo scaffolding, the identity/tenancy data model,
authentication, role-based access control, and hard multi-tenant data isolation. No
product features (students, vehicles, routes, trips, payments) are built here — those
belong to Sub-project 2 onward.

### Goals

- A working NestJS API with login, JWT refresh, logout, and TOTP-based MFA for
  elevated roles.
- Five roles enforced end-to-end: `super_admin`, `school_admin`, `driver`, `attendant`,
  `parent`.
- Multi-tenant data isolation enforced at **two layers**: application-level query
  scoping AND Postgres Row-Level Security, so a bug in one layer cannot leak another
  school's data.
- An audit log that records who did what, from day one (DPDP §36 of idea.md), and is
  immutable at the database grant level, not just by convention.
- A repo structure and local dev setup (`docker-compose up`) that Sub-project 2 can
  build directly on top of without restructuring.
- Passwords hashed with Argon2id under an enforced password policy; refresh tokens
  bound to a device fingerprint with a "revoke all sessions" escape hatch.

### Non-goals (explicitly out of scope for this sub-project)

- Students, guardians, vehicles, drivers-as-a-domain-entity (only `users` with a
  `driver`/`attendant` role exist here — the richer "Driver" and "Attendant" profile
  tables come in Sub-project 2), routes, stops, trips, GPS, payments, notifications,
  compliance documents.
- Admin web app, parent app, driver app — no frontend code, API only.
- Redis, Kafka, WebSockets — reserved for Sub-project 3 (realtime GPS pipeline).
  `docker-compose.yml` provisions Redis now (so the compose file doesn't need
  reshaping later) but nothing in this sub-project uses it.
- Deployment/production infra (Kubernetes, cloud hosting) — local Docker Compose +
  CI test runs only.
- `transport_coordinator` as a distinct role — folds into `school_admin` until a real
  school needs the separation.
- Password reset / email verification flows — login + refresh + logout + MFA only;
  these can be added without restructuring auth.
- A generic, per-school-configurable granular permission engine (per
  `engineering-standards.md` §4) — deliberately deferred until Sub-project 2 has real
  modules/actions to attach permissions to.
- Mobile OTP / passwordless login / Google / Microsoft sign-in — need a third-party
  provider integration; email+password (+MFA) covers Foundations' needs.
- TLS termination, HSTS, subdomain-per-school routing — deployment/ingress concerns,
  not meaningful for local Docker Compose dev.

## 2. Architecture

pnpm-workspace monorepo, single NestJS modular monolith.

```
TransitOS/
├── apps/
│   └── api/
│       ├── src/
│       │   ├── auth/            # login, refresh, logout, guards, decorators
│       │   ├── tenancy/         # request-scoped tenant/RLS context binding
│       │   ├── schools/         # tenant CRUD (super_admin only)
│       │   ├── users/           # user CRUD, role assignment
│       │   ├── audit/           # audit log writer + query
│       │   ├── common/          # exception filter, response envelope, config schema
│       │   ├── database/        # TypeORM data source + migrations
│       │   ├── app.module.ts
│       │   └── main.ts
│       ├── test/                # e2e tests
│       ├── .env.example
│       └── package.json
├── docker-compose.yml            # postgres:16, redis:7 (redis unused this sub-project)
├── pnpm-workspace.yaml
├── package.json                  # workspace root
├── .github/workflows/ci.yml
└── docs/superpowers/specs/
```

Later sub-projects add `apps/admin-web` (Next.js), `apps/mobile` (Flutter) as siblings
under `apps/`, and a `packages/shared-types` package once there's a real API surface
worth sharing types for.

## 3. Data model

Six tables across two Postgres schemas. All columns `snake_case`, all IDs `uuid`
(generated via `gen_random_uuid()` — requires the `pgcrypto` extension), all
timestamps `timestamptz`.

- **`core` schema**: `schools`, `users`, `refresh_tokens`, `password_history`,
  `mfa_credentials`.
- **`audit` schema**: `audit_logs`, kept separate so its distinct grant model (see
  below) is obvious and can't accidentally inherit `core`'s permissions.

`transport`, `payments`, `analytics` schemas are reserved names for Sub-projects 2,
6, and a future analytics sub-project respectively — not created yet.

Two Postgres roles back this: a **migration role** (`DATABASE_MIGRATION_URL`), used
only by the migration-runner, which owns the schemas and can run DDL and any `GRANT`;
and an **app role** (`DATABASE_URL`), used by the running API, which the migrations
grant exactly the privileges each table needs — full CRUD on `core.*`, but only
`INSERT`/`SELECT` on `audit.audit_logs`. The API never connects with the migration
role's credentials.

### `core.schools` (the tenant table)

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| locale | text | default `'en-IN'`; drives future Malayalam/English behavior |
| timezone | text | default `'Asia/Kolkata'` |
| status | text | `active` \| `suspended`, default `active` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

No RLS on `schools` itself in the row-filtering sense — `school_admin`/other
school-scoped roles may only `SELECT` their own row (enforced by a policy comparing
`id` to the session's `app.current_school_id`), and only `super_admin` may
insert/update/delete rows here.

### `core.users`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| school_id | uuid FK → schools.id, nullable | null only for `super_admin` |
| role | text | `super_admin` \| `school_admin` \| `driver` \| `attendant` \| `parent` |
| email | text, unique nullable | |
| phone | text, unique nullable | |
| password_hash | text | Argon2id |
| display_name | text | |
| status | text | `active` \| `disabled`, default `active` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Constraint: `CHECK (role = 'super_admin' OR school_id IS NOT NULL)` — every non-platform
user belongs to exactly one school. Constraint: at least one of `email`/`phone` is not
null.

Password policy (12+ chars, upper/lower/number/symbol, common-password rejection) is
enforced at the application layer (a DTO validator, not a DB constraint) at signup and
password change.

RLS: `USING (school_id = current_setting('app.current_school_id', true)::uuid OR
current_setting('app.is_super_admin', true) = 'true')`.

### `core.password_history`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users.id | |
| password_hash | text | Argon2id, previous hash retained to block reuse |
| created_at | timestamptz | |

Application checks the last 5 entries on password change; RLS scoped by `user_id`
matching the authenticated caller, same rationale as `refresh_tokens` below.

### `core.mfa_credentials`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users.id, unique | one TOTP secret per user |
| secret_encrypted | text | TOTP secret, encrypted at rest (app-level AES-256, key from secrets manager/env) |
| enabled_at | timestamptz nullable | null until the user confirms setup with a valid code |
| created_at | timestamptz | |

Only created/required for `super_admin` and `school_admin` roles; the login flow
checks role to decide whether to demand a second factor. Enrollment is two steps:
`POST /auth/mfa/setup` (authenticated, returns the secret/QR, writes this row with
`enabled_at = NULL`) then `POST /auth/mfa/confirm` (authenticated, a TOTP code proves
the user actually captured the secret, sets `enabled_at`). Only once `enabled_at` is
set does `/auth/login` start returning an MFA challenge for that user; `/auth/mfa/
verify` then completes that challenge with `mfa_challenge_token` + a TOTP code — a
separate endpoint from `/mfa/confirm` because it runs unauthenticated (mid-login),
whereas confirm runs on an already-authenticated session.

### `core.refresh_tokens`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users.id | |
| token_hash | text | sha256 of the raw refresh token; raw value never stored |
| device_fingerprint | text | hash of device/user-agent details supplied at login; refresh is rejected if a presented token's fingerprint doesn't match |
| device_info | text nullable | human-readable device/user-agent string, for the user's "active sessions" view |
| expires_at | timestamptz | |
| revoked_at | timestamptz nullable | |
| created_at | timestamptz | |

Not RLS-scoped by school directly; scoped by `user_id` matching the authenticated
user making the refresh/logout call (application-level check — there is no
"cross-tenant" concern for a token a user only ever presents themselves).

`device_fingerprint` is a best-effort binding — a hash of user-agent/client-supplied
device details, not a hardware attestation. It raises the cost of reusing a stolen
refresh token from a different client (a naive replay fails), it does not stop a
motivated attacker who forges matching device details. Treat it as defense-in-depth,
not a guarantee, and don't test or market it as unspoofable.

### `audit.audit_logs`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| school_id | uuid nullable | null for platform-level (super_admin) actions |
| actor_user_id | uuid FK → users.id, nullable | null if system-initiated |
| action | text | e.g. `user.login`, `user.created`, `school.created` |
| entity_type | text nullable | |
| entity_id | uuid nullable | |
| ip_address | inet nullable | |
| metadata | jsonb | free-form context (may include old/new value diffs), never raw secrets |
| created_at | timestamptz | |

RLS: same pattern as `users` — a school role sees only its own school's rows;
`super_admin` sees all. **Immutability**: the application's Postgres role is granted
`INSERT`, `SELECT` only on this table — no `UPDATE`/`DELETE` grant exists, so a bug
or a compromised app credential cannot alter or erase history; only a separate
migration-run role can touch schema/DDL.

Migrations are hand-written TypeORM migration files (not `synchronize: true`), each
table's `CREATE TABLE` immediately followed by `ALTER TABLE ... ENABLE ROW LEVEL
SECURITY` and its `CREATE POLICY`/`GRANT` statements, so isolation and (for audit)
immutability ship in the same migration as the table, never as an afterthought.

## 4. Auth & tenancy flow

```
POST /auth/login {email|phone, password, device_info}
  → verify password_hash (Argon2id)
  → if role in {super_admin, school_admin} and MFA enabled:
      return {mfa_required: true, mfa_challenge_token} (short-lived, single-use)
      → POST /auth/mfa/verify {mfa_challenge_token, totp_code} continues below
  → issue access JWT (15 min; claims: sub=user_id, school_id, role, is_super_admin)
  → issue refresh token (7 days; random 256-bit value, only its sha256 hash + a
    device_fingerprint derived from device_info stored)
  → write audit_logs row: user.login
  → return {access_token, refresh_token}

Any authenticated request:
  → JwtAuthGuard verifies access token signature + expiry
  → TenancyInterceptor: acquire a TypeORM QueryRunner for this request,
    run `SET LOCAL app.current_school_id = '<school_id or NULL>'`,
    `SET LOCAL app.is_super_admin = '<true|false>'`
  → RolesGuard checks the route's @Roles(...) decorator against JWT's role claim
  → handler executes queries through the request's QueryRunner → RLS applies
  → response wrapped as {success: true, data} or {success: false, error}
  → QueryRunner released, transaction committed/rolled back

POST /auth/refresh {refresh_token, device_info}
  → look up by sha256(refresh_token), reject if revoked/expired
  → reject if the derived device_fingerprint doesn't match the stored one
  → revoke the old row, issue a new access+refresh pair (rotation)

POST /auth/logout {refresh_token}
  → revoke the matching refresh_tokens row
  → write audit_logs row: user.logout

POST /auth/logout-all (authenticated)
  → revoke every non-expired refresh_tokens row for the caller's user_id
  → write audit_logs row: user.logout_all
```

All endpoints above sit behind `@nestjs/throttler` rate limiting to blunt
credential-stuffing / brute-force attempts against `/auth/*`.

Secrets (`JWT_SECRET`, DB credentials) are read from environment variables via a
zod-validated config schema that fails fast at boot if anything required is missing —
never hardcoded, matching your global security rules. `.env.example` documents every
variable; real values only ever in untracked `.env`.

## 5. API surface (this sub-project)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | /auth/login | public | authenticate (returns tokens, or an MFA challenge) |
| POST | /auth/mfa/setup | authenticated (super_admin, school_admin) | generate + return a TOTP secret/QR for enrollment |
| POST | /auth/mfa/confirm | authenticated (super_admin, school_admin) | confirm enrollment with a TOTP code; sets `enabled_at` |
| POST | /auth/mfa/verify | public (valid mfa_challenge_token) | complete a login that returned an MFA challenge |
| POST | /auth/refresh | public (valid refresh token) | rotate tokens |
| POST | /auth/logout | authenticated | revoke refresh token |
| POST | /auth/logout-all | authenticated | revoke all of the caller's sessions |
| GET | /users/me | authenticated | current user profile |
| POST | /schools | super_admin | create a tenant |
| GET | /schools | super_admin | list tenants |
| GET | /schools/:id | super_admin, school_admin (own) | read one tenant |
| POST | /schools/:id/users | super_admin, school_admin (own school) | create a user in a school |
| GET | /schools/:id/users | super_admin, school_admin (own school) | list a school's users |
| GET | /healthz | public | liveness/readiness for CI and local dev |

This is intentionally thin — just enough surface to prove login, RBAC, and RLS all
work end-to-end. Sub-project 2 adds the real product CRUD.

## 6. Error handling

A global `HttpExceptionFilter` catches all thrown errors and normalizes them to
`{success: false, error: {code, message}}`, mapping unexpected errors to a generic
500 message (never leaking stack traces, raw Postgres errors, or RLS policy internals
to the client). Validation errors (via `class-validator` DTOs) map to 400 with a
field-level message list.

## 7. Testing

Following TDD (write the failing test first):

- **Unit tests** (Jest): Argon2id hashing/verification, password policy validator
  (rejects short/common/reused passwords), JWT issuance/validation, refresh-token
  rotation + device-fingerprint mismatch rejection, TOTP secret generation/
  verification, `RolesGuard` behavior, config schema validation (missing env var →
  fails fast).
- **Integration tests** against a real dockerized Postgres (docker-compose, or
  testcontainers if preferred at implementation time):
  - The RLS proof: seed two schools with users each; authenticate as School A's
    `school_admin`; assert querying `/schools/:id/users` for School B returns nothing
    and School A returns exactly School A's users. This is the single most important
    test in this sub-project.
  - `super_admin` can see across schools; `school_admin` cannot escalate by forging a
    `school_id` claim (guard/interceptor derives it only from the verified JWT).
  - The audit-log immutability proof: attempt an `UPDATE`/`DELETE` against
    `audit.audit_logs` using the application's DB role and assert Postgres rejects it
    on a permissions basis, not just that the app code never calls it.
  - MFA proof: a `school_admin` with MFA enabled cannot obtain tokens from
    `/auth/login` alone; a correct `/auth/mfa/verify` call is required.
- **E2E test** (supertest against a running Nest app): login → call a protected
  route with the access token → let the access token expire (or force it) → refresh
  → call the protected route again → logout → refreshed token now rejected. A second
  e2e test covers `/auth/logout-all` revoking a session opened from a different
  simulated device.
- **CI**: GitHub Actions workflow — install (pnpm), lint, run unit+integration+e2e
  tests against a Postgres service container, on every push.

Target: every module above has tests; no numeric coverage gate is enforced by tooling
for this sub-project, but nothing merges without the RLS isolation test and the full
auth-lifecycle e2e test passing.

## 8. Acceptance criteria

- `docker-compose up` brings up Postgres + Redis; `pnpm --filter api start:dev` boots
  the API against them with no manual DB setup beyond running migrations.
- A super_admin, created via a seed script, can log in, create a school, and create a
  school_admin user for it.
- That school_admin can log in and see only their own school's data; a second school's
  school_admin cannot see the first school's data even via direct API calls with a
  tampered payload (only via a stolen/forged JWT, which is a different threat model).
- A school_admin can enroll MFA and subsequently cannot complete login without a
  valid TOTP code; logging out from one device does not revoke sessions on another,
  but `/auth/logout-all` does.
- No application code path can update or delete a row in `audit.audit_logs` — the DB
  grants forbid it outright.
- All tests in §7 pass in CI.
- README documents: prerequisites, `docker-compose up`, running migrations, running
  the seed script, running tests.
