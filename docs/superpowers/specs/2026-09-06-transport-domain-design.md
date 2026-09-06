# TransitOS — Sub-project 2a: Transport Domain API — Design Spec

Status: Approved for planning
Date: 2026-09-06
Depends on: Sub-project 1 (Foundations) — merged at `f3c952e`
Governed by: `engineering-standards.md` §1–5, §7, §9; `2026-09-05-foundations-design.md` for the tenancy, auth and audit substrate
Followed by: Sub-project 2b (trip engine), then 2c (admin web)

## 1. Purpose

Foundations shipped identity, tenancy and audit — no product features. This sub-project adds the domain a school transport office actually manages: students and their guardians, the fleet, the people who drive it, and the routes and stops students are assigned to.

It deliberately stops before trips. The trip state machine (`idea.md` §17) is the hinge every later sub-project hangs off — GPS, attendance, parent notifications, fee adjustments — and it gets its own spec (2b) rather than being appended to CRUD.

### Goals

- The seven entities below, tenant-scoped and RLS-protected on the same pattern Foundations established.
- **Attribute-based access control** so a parent sees only their own children and a driver only the students on their assigned routes — the layer Foundations' RLS deliberately does not provide.
- Every mutation audited, closing the gap the Foundations final review found (only five actions were audited there).
- Route composition: a route with ordered stops, and students assigned to a stop on a route for a given direction and date range.

### Non-goals

- Trips, the trip state machine, driver/vehicle assignment *per trip*, substitutions — Sub-project 2b.
- Any user interface — Sub-project 2c.
- Driver licences, badges, police verification, vehicle RC/insurance/PUC documents and their expiry alerts — Sub-project 7 (compliance vault). 2a stores who drives, not their paperwork.
- Fees and distance-slab tariffs — Sub-project 6, though `student_route_assignments` carries the date ranges those calculations will need.
- PostGIS and any spatial query — Sub-project 3.
- A per-school configurable permission engine. Deferred again, on the same YAGNI grounds Foundations used: coarse roles plus the ABAC below covers every requirement in this sub-project, and no school has asked for a configurable matrix. Recorded here so the deferral stays a decision rather than an oversight.
- Feature flags.

## 2. Schema

A new `transport` schema, reserved by Foundations for this purpose. Every table follows the established conventions: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `school_id uuid NOT NULL REFERENCES core.schools(id)`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`, `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in the same migration that creates the table, and a tenant policy of the form:

```sql
USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
)
```

The `NULLIF` is mandatory — on a pooled connection an unset custom GUC reads back as the empty string, and `''::uuid` raises rather than denying.

### `transport.students`

| column | type | notes |
|---|---|---|
| id, school_id, created_at, updated_at | | standard |
| admission_number | text | unique per school, not globally |
| full_name | text | |
| grade | text | free text — grade naming varies by board |
| section | text nullable | |
| date_of_birth | date nullable | optional; not required to operate transport |
| status | text | `active` \| `inactive`, default `active` |

Students have no login. Deletion is a status change, never a row delete — the audit log's `actor_user_id` foreign key is `ON DELETE NO ACTION`, so hard deletes of referenced rows now fail by design.

Data minimisation is a product rule, not a preference: no religion, caste, Aadhaar or biometrics (`engineering-standards.md` §7). Medical and emergency fields are deliberately absent from 2a; when they arrive they are optional and separately encrypted.

### `transport.student_guardians`

| column | type | notes |
|---|---|---|
| id, school_id, created_at, updated_at | | standard |
| student_id | uuid → students.id | |
| guardian_user_id | uuid → core.users.id | a user with role `parent` |
| relationship | text | `mother` \| `father` \| `grandparent` \| `guardian` \| `other` |
| is_primary | boolean default false | |
| can_collect | boolean default true | whether this guardian may receive the child at drop-off |

This table carries `updated_at` because `is_primary` and `can_collect` are mutable in place — changing whether a guardian may collect a child must not require deleting and recreating the link, which would lose the original `created_at` and produce a misleading audit trail.

UNIQUE `(student_id, guardian_user_id)`. This link table is what ABAC reads to answer "which students may this parent see", and it handles siblings and two working parents without special cases.

`can_collect` is stored now because Sub-project 5's authorised-pickup flow (`idea.md` §26) needs it, and adding it later means backfilling a security-relevant default.

### `transport.vehicles`

| column | type | notes |
|---|---|---|
| id, school_id, created_at, updated_at | | standard |
| registration_number | text | unique per school |
| capacity | int | seats |
| ownership_type | text | `school_owned` \| `contracted` \| `other` |
| operator_name | text nullable | required in practice when `ownership_type <> 'school_owned'` |
| status | text | `active` \| `maintenance` \| `retired`, default `active` |

`ownership_type` ships now because Kerala school transport is genuinely mixed — school-owned buses, contractor fleets, and parent-arranged vehicles (`idea.md` §12, citing the Kerala Police directive). Modelling it later is a migration.

### `transport.routes`

| column | type | notes |
|---|---|---|
| id, school_id, created_at, updated_at | | standard |
| name | text | e.g. "Route 12" |
| description | text nullable | |
| default_vehicle_id | uuid nullable → vehicles.id | the usual bus; per-trip assignment is 2b |
| default_driver_user_id | uuid nullable → core.users.id | a user with role `driver` |
| default_attendant_user_id | uuid nullable → core.users.id | role `attendant` |
| status | text | `active` \| `inactive`, default `active` |

These are *defaults*, not bindings. Which vehicle and driver actually ran a given trip — and substitutions when a bus breaks down — belong to 2b.

### `transport.stops`

| column | type | notes |
|---|---|---|
| id, school_id, created_at, updated_at | | standard |
| name | text | e.g. "Edappally Junction" |
| latitude | numeric(9,6) | |
| longitude | numeric(9,6) | |
| geofence_radius_m | int default 150 | used by Sub-project 3 for approach detection |
| special_instructions | text nullable | |

Coordinates are plain numerics. 2a stores and displays them; nothing queries them spatially. Sub-project 3 adds PostGIS and a geography column when proximity detection actually needs one — introducing it now would be an unused dependency.

### `transport.route_stops`

| column | type | notes |
|---|---|---|
| id, school_id, created_at | | standard |
| route_id | uuid → routes.id | |
| stop_id | uuid → stops.id | |
| sequence | int | order along the route, 1-based |
| expected_offset_minutes | int | minutes from route start to this stop |

UNIQUE `(route_id, sequence)` and UNIQUE `(route_id, stop_id)` — a stop appears at most once per route, and no two stops share a position.

Rows here are immutable, which is why the table has no `updated_at`: the only way to change a route's composition is `PUT /routes/:id/stops`, which replaces the whole set in one transaction.

Expected arrival is stored as an offset from the route's start rather than a wall-clock time, so morning and afternoon runs of the same route reuse one definition and a schedule shift doesn't require rewriting every row.

### `transport.student_route_assignments`

| column | type | notes |
|---|---|---|
| id, school_id, created_at, updated_at | | standard |
| student_id | uuid → students.id | |
| route_id | uuid → routes.id | |
| stop_id | uuid → stops.id | |
| direction | text | `morning` \| `afternoon` \| `both` |
| effective_from | date | |
| effective_to | date nullable | null = open-ended |

The stop must belong to the route — enforced in the service layer, since a CHECK cannot span tables.

Date ranges exist because a mid-year route change is an ordinary event, and Sub-project 6's fee adjustment (`idea.md` §11: route change → recalculated fee → invoice adjustment) needs to know when an assignment started and ended rather than seeing only the current state.

## 3. Access control

This is the substance of the sub-project, and it is where the most likely mistake lives.

**Foundations' RLS is a tenant boundary and never a role boundary.** `users_tenant_all` is `FOR ALL`, so at the database layer any authenticated session already has full rights over its own school's rows. Applied naively to `transport.students`, that means a parent would see **every student in their school**. RLS is the backstop against a forgotten tenant filter; it is not, and must not be mistaken for, the mechanism that narrows a parent to their own children.

So 2a enforces a second, attribute-based layer in the service:

| Role | Sees |
|---|---|
| `super_admin` | everything, across tenants |
| `school_admin` | everything within their school |
| `parent` | only students linked to them through `student_guardians`; only routes and stops those students are assigned to |
| `driver`, `attendant` | only students assigned to routes where they are the default driver/attendant; no guardian contact details |

Every one of those restrictions gets a test that fails if the scoping is removed. That specific failure mode — a test that reads like protection but cannot fail — recurred throughout Foundations and was caught repeatedly in review; it is treated here as a live risk, not a hypothetical.

Guardian contact details are never included in a driver- or attendant-facing response. DTOs are explicit allow-lists, following the `toUserResponse` pattern Foundations established, so a column added later is not exposed by default.

## 4. API surface

All list endpoints are paginated on the Foundations convention — `limit` (default 50, max 200, over-max rejected with 400) and `offset`, returning `{ items, total, limit, offset }` inside the standard `{ success, data }` envelope.

| Method | Path | Roles |
|---|---|---|
| POST/GET | `/students`, `/students/:id` | school_admin (write); parent, driver, attendant read within their ABAC scope |
| PATCH | `/students/:id` | school_admin |
| POST/DELETE | `/students/:id/guardians` | school_admin |
| POST/GET/PATCH | `/vehicles`, `/vehicles/:id` | school_admin |
| POST/GET/PATCH | `/routes`, `/routes/:id` | school_admin; drivers read their own |
| POST/GET/PATCH | `/stops`, `/stops/:id` | school_admin |
| PUT | `/routes/:id/stops` | school_admin — replaces the ordered stop list atomically |
| POST/GET/DELETE | `/students/:id/assignments` | school_admin |

`DELETE` on an assignment **end-dates it** — it sets `effective_to` to today and returns the updated row; it never removes it. Assignment history is what Sub-project 6 reads to calculate a mid-year fee adjustment, and what an operator needs when reconstructing which bus a child was on last term. The corresponding audit action is `assignment.ended`, not `assignment.deleted`.

`PUT /routes/:id/stops` replaces the whole sequence in one transaction rather than exposing per-row insert/reorder/delete. Reordering a route through individual calls cannot be made atomic, and a half-applied reorder leaves duplicate or missing sequence numbers.

## 5. Auditing

Every mutation writes an `audit.audit_logs` row through the existing `AuditService`: `student.created`, `student.updated`, `student.deactivated`, `guardian.linked`, `guardian.unlinked`, `vehicle.created`, `vehicle.updated`, `route.created`, `route.updated`, `route.stops_replaced`, `stop.created`, `stop.updated`, `assignment.created`, `assignment.ended`.

Each carries `entityType`, `entityId`, the acting user and the school. The write happens inside the same request transaction as the mutation, so an audit failure rolls the mutation back — the pattern Foundations' final fix wave established.

This closes the gap the Foundations final review identified: the audit mechanism existed but only five authentication actions ever used it, which would have taught every later sub-project that writing to it is optional.

## 6. Error handling

Unchanged from Foundations: `class-validator` DTOs produce 400s with field-level messages; the global filter normalises everything else and never leaks a raw Postgres or RLS error. Two domain-specific cases:

- Assigning a student to a stop that is not on the given route → 400, naming the mismatch.
- Referencing a driver/attendant user whose role does not match the field → 400. Roles are checked in the service; a foreign key to `core.users` cannot express "must have role driver".

## 7. Testing

Following the Foundations pattern, and its lessons:

- Integration tests against the real database for every RLS policy, including the **empty-string tenant context** case — a test that merely omits setting the variable passes with or without the `NULLIF` guard and proves nothing.
- ABAC tests per role, each written so it fails if the scoping is removed. For the parent case specifically: seed two students in one school, link only one to the parent, and assert the other is invisible — proving the app layer narrows what RLS alone would allow.
- Atomicity test for `PUT /routes/:id/stops`: a replacement that fails partway leaves the original sequence intact.
- Uniqueness and cross-table integrity: duplicate admission number within a school rejected, the same number in a different school accepted, a stop from another route rejected.
- Every fixture identifier generated per run (`randomUUID()`); the suite must pass twice consecutively against the persistent test database.

## 8. Acceptance criteria

- A school_admin can create students, guardians, vehicles, stops and routes; compose a route's stops in order; and assign a student to a stop on that route for a direction and date range.
- A parent authenticating against that school sees exactly their linked children and nothing else — verified over HTTP, not only at the service layer.
- A driver sees the students on their routes and no guardian contact details.
- Every mutation above produces an audit row with the correct actor, entity and school.
- The full suite passes twice consecutively; lint and build clean.
