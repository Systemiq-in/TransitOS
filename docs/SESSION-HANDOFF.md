# TransitOS — Session Handoff & Recovery

**Purpose:** everything a fresh session (or a different person) needs to resume this build without re-deriving anything. If the assistant's memory is wrong and this document disagrees with it, **this document and `git log` win.**

Last updated: 2026-09-05, after Task 6 implementation (Task 6 review in flight).

---

## 1. Where the work lives

| Thing | Location |
|---|---|
| Main repo | `/home/mhdramzy/projects/TransitOS` (branch `main` — docs only, no app code) |
| Active worktree | `/home/mhdramzy/projects/TransitOS/.worktrees/foundations` (branch `foundations`) |
| Spec being implemented | `docs/superpowers/specs/2026-09-05-foundations-design.md` |
| Platform-wide standards | `docs/superpowers/specs/engineering-standards.md` |
| Implementation plan (23 tasks) | `docs/superpowers/plans/2026-09-05-foundations.md` |
| Working ledger | `.superpowers/sdd/2026-09-05-foundations/progress.md` — **gitignored scratch, can vanish** |
| Task briefs & reports | `.superpowers/sdd/2026-09-05-foundations/task-N-{brief,report}.md` — also gitignored |

**All application code is on the `foundations` branch, not `main`.** `main` holds only `idea.md`, the specs, the plan, and `.gitignore`.

Because the ledger is gitignored, the durable record of decisions is: this file, the specs, the plan, and the git history. The ledger is a convenience, not the source of truth.

---

## 2. Local environment (must exist before running anything)

**PostgreSQL runs in a container, NOT via docker-compose.** The only Compose CLI installed on this machine is v1.29.2, which cannot talk to Docker 29.1.3 (`Not supported URL scheme http+docker`). The committed `docker-compose.yml` is correct for anyone with Compose V2 — it is simply not usable here.

Recreate the database container if it is gone:

```bash
docker run -d --name transitos-pg --restart unless-stopped \
  -e POSTGRES_USER=transitos_migrator \
  -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=transitos \
  -p 55432:5432 postgres:16

# then create the test database
PGPASSWORD=devpassword psql -h 127.0.0.1 -p 55432 -U transitos_migrator -d transitos \
  -c 'CREATE DATABASE transitos_test'
```

Port **55432**, not 5432 — this machine already runs its own PostgreSQL on 5432 and it must not be disturbed.

`.env` at the worktree root is gitignored and holds working values. If it is missing, recreate it (secrets can be any fresh random values):

```bash
NODE_ENV=test
PORT=3000
DATABASE_URL=postgres://transitos_app:apppassword@127.0.0.1:55432/transitos_test
DATABASE_MIGRATION_URL=postgres://transitos_migrator:devpassword@127.0.0.1:55432/transitos_test
APP_DB_ROLE=transitos_app
APP_DB_PASSWORD=apppassword
JWT_SECRET=<openssl rand -base64 48>
MFA_ENCRYPTION_KEY=<openssl rand -hex 32>
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=604800
MFA_CHALLENGE_TTL_SECONDS=300
```

Nothing wires up dotenv — tests read `process.env` directly, so **export before running anything**:

```bash
cd /home/mhdramzy/projects/TransitOS/.worktrees/foundations
set -a && . ./.env && set +a
pnpm install
pnpm --filter @transitos/api db:bootstrap   # idempotent; creates the transitos_app role
pnpm --filter @transitos/api test
pnpm --filter @transitos/api lint
```

The app role `transitos_app` is created by the bootstrap script, not by the container.

---

## 3. Progress — what is done

Tasks 1–5 are complete and reviewed clean. Task 6 is implemented and its review was in flight when this was written; check `git log` and the ledger for its outcome.

| Task | State | Commits |
|---|---|---|
| 1 — monorepo scaffold, NestJS, `/healthz`, CI, ESLint | complete, review clean | `d7d65c8`, `4d10ea2` |
| 2 — zod env validation, fail-fast config | complete, review clean | `7789525` |
| 3 — two DB roles, `core`/`audit` schemas, data sources | complete, review clean (1 fix round) | `97ec4d3`, `85f5972` |
| 4 — `core.schools` + RLS | complete, review clean (1 fix round) | `39a23c6`, `9dca638` |
| 5 — `core.users` + RLS + login carve-out | complete, review clean | `700996e` |
| 6 — refresh_tokens / password_history / mfa_credentials | implemented, review in flight | `2139950` |
| 7–23 | not started | — |

Verified live state: migrations `InitSchemas`, `CreateSchools`, `CreateUsers`, `CreateAuthTables` applied; tables `core.schools`, `core.users`, `core.refresh_tokens`, `core.password_history`, `core.mfa_credentials` exist. 28 tests passing.

**Remaining tasks (7–23)**, each fully specified in the plan: 7 audit_logs + immutability · 8 AES-256-GCM secret box · 9 Argon2id + password policy · 10 JWT token service · 11 tenancy context (AsyncLocalStorage + interceptor) · 12 refresh-token lifecycle · 13 TOTP MFA · 14 audit service · 15 guards/decorators · 16 AuthService + controller · 17 response envelope + exception filter · 18 UsersModule · 19 SchoolsModule · 20 AppModule wiring · 21 seed script · 22 e2e tests · 23 README + acceptance.

---

## 4. The process being followed

Superpowers **subagent-driven development**: one fresh implementer subagent per task → task review (spec compliance + quality) → fix loop if needed (max 5 rounds) → next task. After all 23, a whole-branch review, then `finishing-a-development-branch`.

To resume, for task N:

```bash
# from the worktree
SKILL=~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/subagent-driven-development
$SKILL/scripts/task-brief docs/superpowers/plans/2026-09-05-foundations.md N     # writes task-N-brief.md
$SKILL/scripts/review-package docs/superpowers/plans/2026-09-05-foundations.md BASE HEAD
```

Dispatch templates live in `$SKILL/implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`. Record `BASE` (`git rev-parse HEAD`) *before* dispatching each implementer — review packages need it, and `HEAD~1` is wrong for multi-commit tasks.

Rules that have mattered in practice:
- Never run two implementer subagents in parallel.
- Minor findings never enter the fix loop; they are logged and triaged at the final review.
- A finding that conflicts with the plan is decided by the controller, with the **spec** as binding authority, and the decision recorded.
- Implementers never spawn their own reviewers.

---

## 5. Decisions made during execution (rulings)

These resolve gaps and conflicts found in the plan or environment. They are binding on the remaining tasks. Each is stated with what it costs if wrong.

**Already applied (tasks 1–6):**

- **R1** — Task 1 must not overwrite `.gitignore`; the existing one is broader (covers `.env`, `.worktrees/`, `.superpowers/`).
- **R2** — CI omits the `test:e2e` step until Task 22 creates the config, otherwise CI is red for 20 tasks.
- **R3** — Task 3 added `pnpm --filter @transitos/api db:bootstrap` to CI before `pnpm test`; nothing else creates the app role in CI.
- **R4** — `.env.example` documents `SEED_SUPER_ADMIN_EMAIL`/`PASSWORD` as commented, seed-only vars, deliberately outside the zod schema.
- **R11** — compose maps host **55432**/56379 because the machine's own PostgreSQL owns 5432. CI is unchanged (isolated network).
- **R13** — Task 1 added `apps/api/.eslintrc.json`; the plan wired `pnpm lint` into CI without ever specifying a config. It **must** keep `@typescript-eslint/no-unused-vars` with `ignoreRestSiblings: true` and `argsIgnorePattern: "^_"` — Task 2's deliberate discard and the `_context` params in Tasks 11/17 fail lint without them.
- **R14** — do not invoke `docker-compose` on this machine; use the container in §2.
- **R15** — `bootstrap-db.ts` validates the database name via exported `databaseNameFromUrl()` (decode, then `^[A-Za-z_][A-Za-z0-9_$]{0,62}$`) before interpolating it into DDL.
- **R16/R17** — Task 4's visibility assertions are scoped to ids created in that run, and an explicit empty-string tenant-context test exists.
- **R18** — tests generate unique identifiers per run (`core.users.email` is UNIQUE and the test DB persists); the suite must pass twice consecutively.
- **R19** — the carve-out's "no write power" is proven semantically (attempt the write, then re-read under super_admin and assert unchanged), never by asserting on a TypeORM `query()` return shape.

**Still to apply (tasks 7–23):**

- **R5 — Task 11:** use `firstValueFrom(next.handle())`, not the deprecated `.toPromise()`.
- **R6 — Task 16:** `AuthService` must catch failures from `refreshTokenService.rotate()` and `tokenService.verifyMfaChallenge()` and rethrow `UnauthorizedException`. As written they throw plain `Error`, which the global filter maps to **500**, while the spec and Task 22's e2e both require **401**.
- **R7 — Task 22:** `auth-lifecycle.e2e-spec.ts` must create the app in `beforeEach`/close in `afterEach`, so each test gets a fresh throttler window. Five logins in one app instance sit exactly on the 5/60s login limit.
- **R8 — Task 20:** mark `HealthController` `@Public()` when registering the global `JwtAuthGuard`, or `/healthz` returns 401 and the task's own test fails.
- **R10 — Task 16:** reset `app.auth_lookup` to `'false'` immediately after each credential lookup, so the carve-out is not left open for the rest of the request's transaction.
- **R9/R18** continue to apply to every task that seeds rows.

---

## 6. Hard-won behaviour worth not rediscovering

**Pooled connections and custom GUCs.** Once *any* transaction on a pooled connection sets a custom GUC, that connection's *unset* value afterwards is the empty string `''`, not SQL `NULL` (`SET LOCAL` reverts at commit to the session value, which for a never-set custom GUC is an empty-string placeholder). Therefore:

1. `NULLIF(current_setting('app.current_school_id', true), '')::uuid` is **mandatory** in every tenant policy predicate. Without it a reused connection raises `invalid input syntax for type uuid: ""` — a 500 on every unauthenticated request instead of a clean denial.
2. A test that merely *omits* setting the variable proves nothing, because `NULL::uuid` behaves identically with or without the guard. Any new policy on a tenant-scoped table needs an explicit **empty-string** test.

**FORCE ROW LEVEL SECURITY is currently inert** — the schema owner `transitos_migrator` is the container superuser, and superusers bypass RLS regardless of FORCE. It is correct to keep (it becomes load-bearing when the owner is a non-superuser, as it should be in production), but no test proves its effect and none can in this setup.

**TypeORM migration glob** is `[0-9]*.{ts,js}`, narrowed from `*.{ts,js}` because the original also matched sibling `*.spec.ts` files and crashed once a second spec existed in the migrations directory. Keep the timestamp prefix on every migration filename.

---

## 7. If you are a fresh session, start here

1. Read this file, then `docs/ARCHITECTURE.md` and `docs/PROJECT-REQUIREMENTS.md`.
2. `cd` to the worktree, confirm `git log` matches §3, restore the container/`.env` per §2 if needed.
3. Run the suite. It should pass twice in a row. If it does not, fix that before writing anything new.
4. Read `.superpowers/sdd/2026-09-05-foundations/progress.md` if it still exists — it has the fine-grained per-task history, including deferred minor findings for the final review.
5. Resume at the first task in §3 marked not started, using §4's process and honouring §5's rulings.
