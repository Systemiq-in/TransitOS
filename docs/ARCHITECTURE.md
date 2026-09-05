# TransitOS — Architecture

**Scope:** the platform's technical design and the reasoning behind each decision. For *what* we are building and why it is worth building, see `PROJECT-REQUIREMENTS.md`. For current build state and how to resume work, see `SESSION-HANDOFF.md`. The binding specs are in `docs/superpowers/specs/`.

---

## 1. The one-paragraph version

TransitOS is a multi-tenant SaaS: one deployment serves many schools. The whole design turns on a single question — *how do we make it impossible for one school to see another school's children?* The answer is defence in depth: application code scopes every query by tenant, **and** PostgreSQL Row-Level Security enforces the same rule inside the database, so a forgotten `WHERE` clause is a bug rather than a breach. Everything else follows from that choice.

---

## 2. Stack, and why

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Backend | **NestJS + TypeScript**, modular monolith | Matches the research doc's own recommendation; one language across backend and the future Next.js admin web; DI and module boundaries suit a domain that will grow to fees, GPS, notifications. Microservices were rejected for v1 — at 6–10 pilot schools they add deployment surface without solving a problem we have. |
| Database | **PostgreSQL 16** (+ PostGIS later) | RLS is the security backbone; PostGIS covers geofences and route corridors natively when GPS lands. |
| ORM | **TypeORM** | Chosen over Prisma specifically because RLS needs per-connection `SET LOCAL` session variables, and TypeORM's `QueryRunner` exposes a connection directly. Prisma would require wrapping every query in an interactive transaction to get the same guarantee. |
| Auth | JWT access tokens + rotating refresh tokens, **Argon2id** hashing, TOTP MFA | Argon2id is the current password-hashing standard; refresh rotation plus device binding limits stolen-token value. |
| Realtime (later) | Redis + WebSockets, queue in front of GPS ingestion | Keeps the high-frequency GPS path off the primary database; the queue is also the seam where a Go ingestion service could replace Node if load ever demands it. |
| Runtime | Node 20+, pnpm workspaces | Single-repo, multiple apps, no Nx/Turborepo until there is something to orchestrate. |

**Deliberately deferred:** Kafka, Kubernetes, microservices, GraphQL, a generic permission engine. Each is in the long-term picture; none earns its complexity at MVP.

---

## 3. Repository shape

```
TransitOS/
├── apps/
│   └── api/                     # NestJS modular monolith (all backend logic)
│       ├── scripts/             # bootstrap-db, seed — operational entry points
│       └── src/
│           ├── config/          # zod env schema; fails fast at boot
│           ├── database/        # data sources + hand-written migrations
│           ├── entities/        # TypeORM entities, one file each
│           ├── tenancy/         # AsyncLocalStorage tenant context + interceptor
│           ├── auth/            # password, token, refresh, MFA, guards, controller
│           ├── audit/           # append-only audit writer
│           ├── users/ schools/  # domain modules
│           └── common/          # response envelope, exception filter
├── docs/                        # this file, requirements, handoff, specs, plans
└── docker-compose.yml           # postgres + redis for local dev
```

Later sub-projects add `apps/admin-web` (Next.js) and `apps/mobile` (Flutter) as siblings.

Auth is split by *responsibility* — password hashing, JWT minting, refresh lifecycle, MFA, and orchestration are separate services rather than one `auth.service.ts` — because each has its own test surface and later sub-projects need some without the others.

---

## 4. Multi-tenant isolation (the core mechanism)

Three layers, each independently sufficient to catch a mistake in the others.

**Layer 1 — schema separation.** `core` holds identity and tenancy; `audit` holds the audit log with a different grant model. `transport`, `payments`, and `analytics` are reserved for later sub-projects.

**Layer 2 — two database roles.**
- A **migration role** owns the schemas and runs all DDL.
- An **app role** is what the running API connects as. It holds `USAGE` but never `CREATE` on the schemas, so the application literally cannot alter its own schema; and it has only `INSERT`/`SELECT` on `audit.audit_logs`, so it cannot rewrite history.

**Layer 3 — Row-Level Security.** Every tenant-scoped table gets `ENABLE` *and* `FORCE ROW LEVEL SECURITY` in the same migration that creates it, plus policies keyed on session variables:

| Session variable | Meaning |
|---|---|
| `app.current_school_id` | the caller's tenant — a uuid string, or `''` when there is none |
| `app.is_super_admin` | `'true'` grants cross-tenant access (platform operators only) |
| `app.auth_lookup` | `'true'` only during pre-authentication credential lookup |

Predicates take the form:

```sql
USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
)
```

The `NULLIF` is not cosmetic. On a pooled connection an unset custom GUC reads back as `''`, and `''::uuid` raises a cast error — so without it, a reused connection 500s instead of denying access. This is the production path, not an edge case.

**How the context gets set.** Each authenticated request opens a transaction, stamps the caller's verified JWT claims into those session variables via `SET LOCAL`, and runs every query inside it through an `AsyncLocalStorage`-held `EntityManager`. `getManager()` throws outside that scope, so a handler cannot accidentally reach the unscoped global connection.

**The one deliberate hole, and why it is safe.** `/auth/login` must find a user by email before any tenant context can exist. A single extra policy on `core.users` permits that lookup — but it is `FOR SELECT` only, gated on `app.auth_lookup`, and reset immediately after the lookup. Review verified that no combination of session variables lets that flag read across tenants without being set, or write anything while it is set. Postgres consults `FOR SELECT` policies only for reads, so the flag structurally cannot enable a write.

**Tables deliberately without RLS:** `refresh_tokens`, `password_history`, `mfa_credentials`. All three are read in flows that run *before* a tenant or user context exists, and `password_history` is written by an admin creating another user — a user-scoped policy would reject that legitimate write. They hold no tenant-queryable data and are reachable only through auth flows filtered by a server-derived `user_id`.

---

## 5. Identity and access

**Roles (exactly five):** `super_admin` (platform operator), `school_admin`, `driver`, `attendant`, `parent`.

A generic per-school configurable permission engine is **deliberately deferred** — building one before there are modules and actions to attach permissions to is speculative. Coarse roles cover the MVP; the engine arrives when Sub-project 2 has real surface to govern.

**Login flow:**

```
POST /auth/login
  → SET LOCAL app.auth_lookup='true'; find user by email/phone; reset flag
  → verify Argon2id hash
  → if super_admin/school_admin with MFA enabled → return a short-lived MFA challenge
  → else issue access JWT (15 min) + refresh token (7 days, sha256-hashed at rest,
    bound to a device fingerprint)
  → write an audit_logs row
```

Refresh tokens rotate on use and can be revoked individually or all at once. The device fingerprint is best-effort — it raises the cost of replaying a stolen token from another client, but it is not hardware attestation and is not marketed as such.

**Audit logging** is append-only at the grant level: the app role has no `UPDATE`/`DELETE` on `audit.audit_logs` at all, so tampering fails at the privilege check rather than relying on application discipline. Writes are always permitted (a login must be auditable before the caller is authenticated); reads are tenant-scoped.

---

## 6. Cross-cutting request pipeline

```
request
  → ThrottlerGuard      (rate limit before doing any work)
  → JwtAuthGuard        (verify token, attach claims; skipped for @Public routes)
  → RolesGuard          (check @Roles against the verified claim)
  → TenancyInterceptor  (open transaction, SET LOCAL from claims)
  → handler             (queries run through the request's scoped EntityManager)
  → ResponseInterceptor ({ success: true, data })
  → commit / rollback
```

Errors are normalised by a global filter to `{ success: false, error: { code, message } }`. Unrecognised errors become a generic 500 — raw Postgres errors and RLS policy internals never reach a client.

---

## 7. Privacy posture

This system processes children's location data, which drives several design constraints beyond ordinary SaaS practice: purpose limitation and data minimisation (no Aadhaar, caste, religion, or biometrics), guardian consent as a versioned record, encryption at rest for documents and emergency fields, GPS history windows that differ per role, notification payloads that never carry precise location, and time-limited, audited support access instead of standing platform access to any school's data.

Full detail, tagged by owning sub-project, is in `docs/superpowers/specs/engineering-standards.md`. Foundations implements the identity, isolation, and audit substrate those controls build on.

---

## 8. Decision log

| Decision | Rationale | What would change it |
|---|---|---|
| Modular monolith, not microservices | Fastest path at pilot scale; module boundaries preserve the option | Sustained load on the GPS path |
| TypeORM over Prisma | RLS needs per-connection `SET LOCAL` | If Prisma gains first-class session-variable support |
| RLS as a backstop, not the only control | A forgotten filter should be a bug, not a breach | Nothing foreseeable |
| Postgres schema separation from day one | Retrofitting schemas across a live multi-tenant DB is painful | — |
| MFA for admin roles only | Blast radius; drivers/parents gain friction without matched risk | A pilot school requesting it |
| Coarse RBAC now, ABAC later | The rules only make sense once students/trips exist | Sub-project 2 |
| One shared test database, no teardown | Matches how the suite is written; tests generate unique identifiers per run | Parallel test execution |
