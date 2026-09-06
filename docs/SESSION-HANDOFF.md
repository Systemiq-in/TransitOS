# TransitOS — Session Handoff & Recovery

**Purpose:** everything a fresh session (or a different person) needs to resume this
build without re-deriving anything. If the assistant's memory disagrees with this
document, **this document and `git log` win.**

Last updated: 2026-09-06, after Sub-project 2a Tasks 1–3 passed review. Task 4 is next.

---

## 1. Where things stand, in one paragraph

Sub-project 1 (**Foundations**) is shipped and merged to `main`: identity, JWT auth,
multi-tenancy enforced by Postgres Row-Level Security, and audit logging. Sub-project
2a (**transport domain**) has a finished 16-task implementation plan on `main`, and
**tasks 1–3 of 16 are implemented, reviewed and green** on the branch
`feat/transport-domain`. Execution is mid-flight. The next action is dispatching Task 4.

---

## 2. Resume in three commands

```bash
cd ~/projects/TransitOS/.worktrees/transport-domain   # work happens HERE, not the main checkout
cat .superpowers/sdd/2026-09-06-transport-domain/progress.md   # the ledger — read first
git log --oneline 3b4d4c1..HEAD
```

The ledger's last section is headed `## NEXT:` and names the task to dispatch, its
BASE commit, and the four things that must be carried into that dispatch.

The ledger is **gitignored scratch and can vanish** (`git clean -fdx` destroys it). The
durable record is this file, the spec, the plan, and the git history.

---

## 3. Where the work lives

| Thing | Location |
|---|---|
| Main repo | `~/projects/TransitOS`, branch `main` @ `3b4d4c1` — Foundations code + all docs. Clean. |
| Active worktree | `~/projects/TransitOS/.worktrees/transport-domain`, branch `feat/transport-domain`. Clean, 5 commits ahead. |
| **Spec (binding authority)** | `docs/superpowers/specs/2026-09-06-transport-domain-design.md` |
| Plan (16 tasks, 5,682 lines) | `docs/superpowers/plans/2026-09-06-transport-domain.md` |
| Platform-wide standards | `docs/superpowers/specs/engineering-standards.md` — Part I security/privacy, Part II performance, each control tagged by owning sub-project |
| Foundations spec & plan | `docs/superpowers/specs/2026-09-05-foundations-design.md`, `docs/superpowers/plans/2026-09-05-foundations.md` |
| Rulings from Foundations | `docs/DECISIONS.md` — 38 entries, each with cost-if-wrong |
| SDD workspace (gitignored) | `.worktrees/transport-domain/.superpowers/sdd/2026-09-06-transport-domain/` — ledger, briefs, reports, review diffs |

The plan argues *from* the spec. Where they conflict, the spec wins.

---

## 4. Commits on `feat/transport-domain`

```
5bb5eec test: add cross-tenant isolation tests for student_guardians, vehicles, stops
6639f2d feat: add vehicles and stops tables with tenant RLS
72c1092 feat: add student_guardians link table with tenant RLS
051cc49 fix: tighten transport.students grant and RLS test coverage
cf12839 feat: add transport schema and students table with tenant RLS
```

Full API suite: **180/180 passing, twice consecutively.** Working tree clean.

---

## 5. Task status

| Tasks | State |
|---|---|
| 1 — `transport` schema + `students` | complete, review clean |
| 2 — `student_guardians` | complete, review clean |
| 3 — `vehicles` + `stops` | complete, review clean |
| **4 — `routes` + `route_stops`** | **NEXT.** Brief pre-extracted. BASE = `5bb5eec` |
| 5 — `student_route_assignments` | brief pre-extracted |
| 6 — `AbacScopeService` | brief pre-extracted. **The security core of 2a** |
| 7–9 — students & guardians services + HTTP | not started |
| 10 — vehicles · 11 — stops | not started |
| 12–13 — routes + atomic stop replacement | not started |
| 14 — assignments · 15 — module wiring · 16 — e2e + README | not started |

Briefs for 2–6 already exist in the workspace. For later tasks:

```bash
SK=~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/subagent-driven-development
$SK/scripts/task-brief      docs/superpowers/plans/2026-09-06-transport-domain.md <N>
$SK/scripts/review-package  docs/superpowers/plans/2026-09-06-transport-domain.md <BASE> HEAD
```

---

## 6. Process being followed

`superpowers:subagent-driven-development`. Per task: extract the brief → dispatch a
fresh implementer (hand it the **brief path**, never the whole plan) → generate a
review package → dispatch a task reviewer for **two** verdicts, spec compliance *and*
quality → fix loop, max 5 rounds, resuming the same implementer for rounds 1–3 →
scoped re-review → ledger the completion. After all 16: a whole-branch final review on
the most capable model, then `superpowers:finishing-a-development-branch`.

Rules that matter: never run two implementers in parallel; never fix findings in the
controller session (it skips review); every ruling goes in the ledger.

---

## 7. Rulings made this session

Full reasoning is in the ledger. Reverse any you disagree with.

1. **Task 13 keeps its direct `Stop` repository lookup** instead of calling
   `StopsService` — it validates a whole list in one batched `In(stopIds)` query.
   *Cost if wrong: one unused module export.*
2. **Task 14 end-dates with SQL `CURRENT_DATE`, not a Node-computed date.** Postgres
   runs `Etc/UTC`, Node runs `Asia/Calcutta`; they agree today only by luck.
   *Cost if wrong: a route change between 00:00–05:30 IST lands on the wrong day.*
3. **`DELETE` is granted only where the domain genuinely deletes rows** —
   `student_guardians` and `route_stops`. Students, vehicles, stops, routes and
   assignments get `SELECT, INSERT, UPDATE`, which makes "never hard-deleted" a
   database guarantee instead of service-layer discipline.
   *Cost if wrong: a future delete needs a migration to re-grant.*
4. **Every table's spec needs a positive-path RLS test** proving a correctly-scoped
   tenant can read its own row. *Cost if wrong: none, added coverage.*
5. **Every table's spec needs a cross-tenant denial test** using a second real school.
   *Cost if wrong: none, added coverage.*
6. **Tasks 2+3 and 4+5 are batched** into one implementer dispatch each — same shape,
   complete code in the briefs, disjoint files. *Cost if wrong: a batched review
   spreads attention; mitigated by a per-table review lens.*
7. **A Minor finding against the implementer was withdrawn** — the reviewer misread
   the brief, and the implementer correctly refused to write a falsehood into its
   report. *Cost if wrong: none.*
8. **Task 3's transposed-coordinate fixture was corrected** by the implementer (see
   below). *Cost if wrong: none.*

---

## 8. Three defects the review layer found in the plan itself

All three are the same failure mode — **tests that read like protection but cannot
fail** — and the same mode may lurk in the twelve unbuilt tasks:

- Task 1's four RLS tests would all have passed under a `USING (false)` policy. None
  asserted that a tenant could read its *own* row.
- Tasks 2–5's briefs omitted the cross-tenant isolation test Task 1 happened to have.
  A policy reading `... OR current_setting('app.current_school_id', true) <> ''` —
  granting access on any non-empty context without ever comparing `school_id` — would
  have passed every test across three tables.
- Task 3's "rejects a transposed coordinate pair" test used real Kerala coordinates
  (lat ~10, long ~76). Swapped, both still sit inside ±90, so it passed whether or not
  the CHECK constraint existed.

**Bite-checks are mandatory, and they must discriminate.** Breaking a policy to
`USING (false)` proves little, because it fails every test at once. Break it to a
*plausible but wrong* predicate instead, and require that the new test fails while the
existing ones keep passing.

---

## 9. Local environment

- **PostgreSQL 16 runs in a container, not via docker-compose.** Container
  `transitos-pg`, host port **55432** (the host's own Postgres owns 5432). Databases
  `transitos` and `transitos_test`. Roles: `transitos_migrator` (DDL owner) and
  `transitos_app` (no CREATE, no UPDATE/DELETE on audit). Compose V2 is unavailable on
  this machine; the committed `docker-compose.yml` is correct for anyone who has it.
- `.env` is gitignored and present in **both** the main checkout and the worktree.
- Load it before anything touching the database: `set -a && . ./.env && set +a`
- `rm` is aliased to interactive here — use `command rm -f` in scripts.
- The bash working directory drifts between the worktree and the main checkout
  between calls. Prefix commands with an explicit `cd`.

---

## 10. Running it by hand — verified working 2026-09-06

```bash
cd ~/projects/TransitOS
set -a && . ./.env && set +a
pnpm --filter @transitos/api start:dev            # :3000

SEED_SUPER_ADMIN_EMAIL='you@transitos.local' \
SEED_SUPER_ADMIN_PASSWORD='Correct-Horse9!' \
  pnpm --filter @transitos/api seed

TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"emailOrPhone":"you@transitos.local","password":"Correct-Horse9!"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.accessToken")

curl -s localhost:3000/users/me -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/schools -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"St Marys HSS Kochi"}'
```

Live endpoints: `/healthz`, `/auth/*` (login, refresh, logout, logout-all, MFA
setup/confirm/verify), `/users/me`, `/schools*`.

**There is no UI of any kind**, and no transport endpoints yet — the transport tables
exist in the database, but their HTTP surface begins at Task 8 and is complete at
Task 16. A dev server may still be running from the last session;
`pkill -f "nest start"` stops it.

**Housekeeping:** the dev database `transitos` holds ~1,126 test-fixture schools
("Springfield School", "School A", "Audited School <uuid>") from a test run that
pointed at it instead of `transitos_test`. Harmless; `db:bootstrap` + `seed` gives a
clean slate.

---

## 11. Road ahead

Sub-project **2b** (trip engine — the state machine GPS, attendance, notifications and
fee adjustments all hang off), then **2c** (admin web), then 3–8. A marketing landing
page is queued after all platform work; its audience and positioning are already
captured in `PROJECT-REQUIREMENTS.md` §4.

---

## 12. Working agreement with the user

Terse replies, minimal narration, no progress check-ins mid-execution — execute and
report at the end. Commits, docs, specs, plans and subagent dispatch prompts stay in
normal prose regardless. Don't update this handoff file again unless asked.
