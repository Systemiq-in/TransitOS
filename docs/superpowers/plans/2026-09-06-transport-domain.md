# Transport Domain API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the transport domain — students, guardians, vehicles, routes, stops and student-to-stop assignments — on top of the Foundations substrate, with attribute-based access control narrowing what Row-Level Security alone would permit.

**Architecture:** A new `transport` Postgres schema holding seven tenant-scoped tables, each with `ENABLE`/`FORCE ROW LEVEL SECURITY` and the tenant predicate Foundations established. RLS remains the tenant backstop; a new `AbacScopeService` adds the role-attribute layer deciding *which* students a parent or driver may see within their school. Every mutation writes an audit row inside the request transaction.

**Tech Stack:** NestJS 10, TypeORM 0.3, PostgreSQL 16, class-validator, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-06-transport-domain-design.md`

## Global Constraints

- All new tables live in the `transport` schema; `core` and `audit` are untouched.
- Every table: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `school_id uuid NOT NULL REFERENCES core.schools(id)`, `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also `updated_at timestamptz NOT NULL DEFAULT now()`.
- Every table gets `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` in the same migration that creates it, plus its policy and its grant.
- The tenant policy predicate is exactly:
  `current_setting('app.is_super_admin', true) = 'true' OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid`
  applied to both `USING` and `WITH CHECK`. The `NULLIF` is mandatory — on a pooled connection an unset custom GUC reads back as `''`, and `''::uuid` raises rather than denying.
- Migration filenames keep the timestamp prefix (`[0-9]*`), or the migration data source's glob will not pick them up.
- Grants go to the app role from `validateEnv(process.env).APP_DB_ROLE`, never a hardcoded name.
- **RLS is a tenant boundary and never a role boundary.** Narrowing a parent to their own children is the service layer's job. Never rely on a policy for it.
- Every mutation writes an audit row via `AuditService.record` inside the same request transaction.
- Students and assignments are never hard-deleted: students get `status = 'inactive'`, assignments get `effective_to` set.
- Never expose guardian contact details in a driver- or attendant-facing response. DTOs are explicit allow-lists.
- All list endpoints use `PaginationQueryDto` (`limit` default 50, min 1, max 200 — over-max is a 400; `offset` default 0) and return `{ items, total, limit, offset }`.
- TDD: failing test first, watch it fail, then implement. Conventional commits. Test output pristine. No `any`. Unused params prefixed `_`.
- Fixture identifiers generated per run with `randomUUID()`; the suite must pass twice consecutively against the persistent test database.
- Load the environment before anything touching the database: `set -a && . ./.env && set +a`.

## File Structure

```
apps/api/src/
├── database/migrations/
│   ├── 1757030600000-CreateTransportStudents.ts       # Task 1
│   ├── 1757030700000-CreateStudentGuardians.ts        # Task 2
│   ├── 1757030800000-CreateVehiclesAndStops.ts        # Task 3
│   ├── 1757030900000-CreateRoutesAndRouteStops.ts     # Task 4
│   └── 1757031000000-CreateStudentRouteAssignments.ts # Task 5
├── entities/
│   ├── student.entity.ts                        # Task 1
│   ├── student-guardian.entity.ts               # Task 2
│   ├── vehicle.entity.ts, stop.entity.ts        # Task 3
│   ├── route.entity.ts, route-stop.entity.ts    # Task 4
│   └── student-route-assignment.entity.ts       # Task 5
└── transport/
    ├── abac/abac-scope.service.ts               # Task 6 — the access-control core
    ├── students/                                 # Tasks 7-9
    ├── vehicles/                                 # Task 10
    ├── stops/                                    # Task 11
    ├── routes/                                   # Tasks 12-13
    ├── assignments/                              # Task 14
    └── transport.module.ts                       # Task 15
```

Each domain folder holds its service, controller, module and a `dto/` directory, mirroring `src/schools/`. `AbacScopeService` is deliberately separate from any one domain: students, routes and assignments all consult it, so keeping the role-narrowing rules in one file means they can be read and tested in one place rather than re-derived per module.

**Task list:** 1–5 schema and entities · 6 ABAC core · 7–9 students and guardians · 10 vehicles · 11 stops · 12–13 routes and atomic stop replacement · 14 assignments · 15 module wiring · 16 e2e and README.

---

### Task 1: `transport` schema and `transport.students`

**Files:**
- Create: `apps/api/src/database/migrations/1757030600000-CreateTransportStudents.ts`
- Create: `apps/api/src/entities/student.entity.ts`
- Test: `apps/api/src/database/migrations/create-transport-students.spec.ts`

**Interfaces:**
- Consumes: `migrationDataSource` from `src/database/data-source.migration`, `appDataSourceOptions` from `src/database/data-source`, `validateEnv` from `src/config/env.schema`.
- Produces: the `transport` schema; `transport.students`; the `Student` entity with fields `id, schoolId, admissionNumber, fullName, grade, section, dateOfBirth, status, createdAt, updatedAt` and the exported type `StudentStatus = 'active' | 'inactive'`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-transport-students.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('CreateTransportStudents migration', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let schoolB: string;

  const asSuperAdmin = async <T>(fn: (q: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['true']);
    try {
      const result = await fn((sql) => runner.query(sql));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  const asTenant = async (schoolId: string, sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
    await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, [schoolId]);
    const rows = (await runner.query(sql, params)) as unknown[];
    await runner.rollbackTransaction();
    await runner.release();
    return rows;
  };

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
    await asSuperAdmin(async (q) => {
      const a = (await q(`INSERT INTO core.schools (name) VALUES ('A-${randomUUID()}') RETURNING id`)) as { id: string }[];
      const b = (await q(`INSERT INTO core.schools (name) VALUES ('B-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolA = a[0].id;
      schoolB = b[0].id;
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('creates the transport schema', async () => {
    const rows = await migrator.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'transport'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('hides one school students from another school session', async () => {
    const admission = `ADM-${randomUUID()}`;
    await asSuperAdmin(async (q) => {
      await q(`INSERT INTO transport.students (school_id, admission_number, full_name, grade)
               VALUES ('${schoolA}', '${admission}', 'Aisha', '5')`);
    });

    const rows = await asTenant(schoolB, `SELECT id FROM transport.students WHERE admission_number = $1`, [admission]);
    expect(rows).toEqual([]);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const rows = await asTenant('', `SELECT id FROM transport.students`);
    expect(rows).toEqual([]);
  });

  it('rejects a duplicate admission number in one school but allows it across schools', async () => {
    const admission = `DUP-${randomUUID()}`;
    await asSuperAdmin(async (q) => {
      await q(`INSERT INTO transport.students (school_id, admission_number, full_name, grade)
               VALUES ('${schoolA}', '${admission}', 'One', '5')`);
    });

    await expect(
      asSuperAdmin(async (q) => {
        await q(`INSERT INTO transport.students (school_id, admission_number, full_name, grade)
                 VALUES ('${schoolA}', '${admission}', 'Two', '5')`);
      }),
    ).rejects.toThrow(/duplicate key/i);

    const other = await asSuperAdmin(async (q) =>
      q(`INSERT INTO transport.students (school_id, admission_number, full_name, grade)
         VALUES ('${schoolB}', '${admission}', 'Three', '5') RETURNING id`),
    );
    expect(other).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-transport-students`
Expected: FAIL — `relation "transport.students" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030600000-CreateTransportStudents.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateTransportStudents1757030600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS transport`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA transport TO ${appRole}`);

    await queryRunner.query(`
      CREATE TABLE transport.students (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        admission_number text NOT NULL,
        full_name text NOT NULL,
        grade text NOT NULL,
        section text,
        date_of_birth date,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT students_status_check CHECK (status IN ('active', 'inactive')),
        CONSTRAINT students_admission_unique UNIQUE (school_id, admission_number)
      )
    `);
    await queryRunner.query(`CREATE INDEX students_school_id_idx ON transport.students (school_id)`);

    await queryRunner.query(`ALTER TABLE transport.students ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE transport.students FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY students_tenant_all ON transport.students
        FOR ALL
        USING (
          current_setting('app.is_super_admin', true) = 'true'
          OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
        )
        WITH CHECK (
          current_setting('app.is_super_admin', true) = 'true'
          OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
        )
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON transport.students TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS transport.students`);
  }
}
```

- [ ] **Step 4: Write the entity**

`apps/api/src/entities/student.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type StudentStatus = 'active' | 'inactive';

@Entity({ schema: 'transport', name: 'students' })
export class Student {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ name: 'admission_number', type: 'text' })
  admissionNumber: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName: string;

  @Column({ type: 'text' })
  grade: string;

  @Column({ type: 'text', nullable: true })
  section: string | null;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({ type: 'text' })
  status: StudentStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-transport-students`
Expected: PASS, 4 tests. Then run the full suite twice; both runs green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1757030600000-CreateTransportStudents.ts \
        apps/api/src/database/migrations/create-transport-students.spec.ts \
        apps/api/src/entities/student.entity.ts
git commit -m "feat: add transport schema and students table with tenant RLS"
```

---

### Task 2: `transport.student_guardians`

**Files:**
- Create: `apps/api/src/database/migrations/1757030700000-CreateStudentGuardians.ts`
- Create: `apps/api/src/entities/student-guardian.entity.ts`
- Test: `apps/api/src/database/migrations/create-student-guardians.spec.ts`

**Interfaces:**
- Consumes: `transport.students` and `core.users` (a user with role `parent`).
- Produces: `transport.student_guardians`; the `StudentGuardian` entity with `id, schoolId, studentId, guardianUserId, relationship, isPrimary, canCollect, createdAt, updatedAt` and `GuardianRelationship = 'mother' | 'father' | 'grandparent' | 'guardian' | 'other'`. **Task 6 reads this table to decide which students a parent may see** — it is the ABAC join.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-student-guardians.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('CreateStudentGuardians migration', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let studentA: string;
  let parentA: string;

  const asSuperAdmin = async <T>(fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['true']);
    try {
      const result = await fn((sql, p) => runner.query(sql, p));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
    await asSuperAdmin(async (q) => {
      const s = (await q(`INSERT INTO core.schools (name) VALUES ('G-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolA = s[0].id;
      const st = (await q(
        `INSERT INTO transport.students (school_id, admission_number, full_name, grade)
         VALUES ($1, $2, 'Child', '5') RETURNING id`,
        [schoolA, `ADM-${randomUUID()}`],
      )) as { id: string }[];
      studentA = st[0].id;
      const u = (await q(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'parent', $2, 'x', 'Parent') RETURNING id`,
        [schoolA, `parent-${randomUUID()}@example.com`],
      )) as { id: string }[];
      parentA = u[0].id;
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('links a guardian to a student', async () => {
    const rows = await asSuperAdmin(async (q) =>
      q(
        `INSERT INTO transport.student_guardians (school_id, student_id, guardian_user_id, relationship)
         VALUES ($1, $2, $3, 'mother') RETURNING id`,
        [schoolA, studentA, parentA],
      ),
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects linking the same guardian to the same student twice', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.student_guardians (school_id, student_id, guardian_user_id, relationship)
           VALUES ($1, $2, $3, 'father')`,
          [schoolA, studentA, parentA],
        ),
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
    await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, ['']);
    const rows = await runner.query(`SELECT id FROM transport.student_guardians`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-student-guardians`
Expected: FAIL — `relation "transport.student_guardians" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030700000-CreateStudentGuardians.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateStudentGuardians1757030700000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE transport.student_guardians (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        student_id uuid NOT NULL REFERENCES transport.students(id),
        guardian_user_id uuid NOT NULL REFERENCES core.users(id),
        relationship text NOT NULL,
        is_primary boolean NOT NULL DEFAULT false,
        can_collect boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT student_guardians_relationship_check
          CHECK (relationship IN ('mother', 'father', 'grandparent', 'guardian', 'other')),
        CONSTRAINT student_guardians_unique UNIQUE (student_id, guardian_user_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX student_guardians_guardian_idx ON transport.student_guardians (guardian_user_id)`,
    );

    await queryRunner.query(`ALTER TABLE transport.student_guardians ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE transport.student_guardians FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY student_guardians_tenant_all ON transport.student_guardians
        FOR ALL
        USING (
          current_setting('app.is_super_admin', true) = 'true'
          OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
        )
        WITH CHECK (
          current_setting('app.is_super_admin', true) = 'true'
          OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
        )
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON transport.student_guardians TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS transport.student_guardians`);
  }
}
```

The index on `guardian_user_id` exists because every ABAC-scoped request from a parent queries this table by that column — it is the hottest lookup the sub-project adds.

- [ ] **Step 4: Write the entity**

`apps/api/src/entities/student-guardian.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type GuardianRelationship = 'mother' | 'father' | 'grandparent' | 'guardian' | 'other';

@Entity({ schema: 'transport', name: 'student_guardians' })
export class StudentGuardian {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ name: 'student_id', type: 'uuid' })
  studentId: string;

  @Column({ name: 'guardian_user_id', type: 'uuid' })
  guardianUserId: string;

  @Column({ type: 'text' })
  relationship: GuardianRelationship;

  @Column({ name: 'is_primary', type: 'boolean' })
  isPrimary: boolean;

  @Column({ name: 'can_collect', type: 'boolean' })
  canCollect: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-student-guardians`
Expected: PASS, 3 tests. Then the full suite twice, green both times.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1757030700000-CreateStudentGuardians.ts \
        apps/api/src/database/migrations/create-student-guardians.spec.ts \
        apps/api/src/entities/student-guardian.entity.ts
git commit -m "feat: add student_guardians link table with tenant RLS"
```

---

### Task 3: `transport.vehicles` and `transport.stops`

**Files:**
- Create: `apps/api/src/database/migrations/1757030800000-CreateVehiclesAndStops.ts`
- Create: `apps/api/src/entities/vehicle.entity.ts`, `apps/api/src/entities/stop.entity.ts`
- Test: `apps/api/src/database/migrations/create-vehicles-and-stops.spec.ts`

**Interfaces:**
- Consumes: `core.schools`, `validateEnv`.
- Produces: `transport.vehicles`, `transport.stops`; entities `Vehicle` (`id, schoolId, registrationNumber, capacity, ownershipType, operatorName, status, createdAt, updatedAt`; `VehicleOwnership = 'school_owned' | 'contracted' | 'other'`, `VehicleStatus = 'active' | 'maintenance' | 'retired'`) and `Stop` (`id, schoolId, name, latitude, longitude, geofenceRadiusM, specialInstructions, createdAt, updatedAt`).

Both tables ship together because each is a standalone lookup with no dependency on the other; splitting them would create two near-identical review surfaces.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-vehicles-and-stops.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('CreateVehiclesAndStops migration', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;

  const asSuperAdmin = async <T>(fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['true']);
    try {
      const result = await fn((sql, p) => runner.query(sql, p));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
    await asSuperAdmin(async (q) => {
      const s = (await q(`INSERT INTO core.schools (name) VALUES ('V-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolA = s[0].id;
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('stores a contracted vehicle with its operator', async () => {
    const rows = (await asSuperAdmin(async (q) =>
      q(
        `INSERT INTO transport.vehicles (school_id, registration_number, capacity, ownership_type, operator_name)
         VALUES ($1, $2, 36, 'contracted', 'Kerala Travels') RETURNING ownership_type, operator_name`,
        [schoolA, `KL-07-${randomUUID().slice(0, 6)}`],
      ),
    )) as { ownership_type: string; operator_name: string }[];
    expect(rows[0]).toEqual({ ownership_type: 'contracted', operator_name: 'Kerala Travels' });
  });

  it('rejects an unknown ownership type', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.vehicles (school_id, registration_number, capacity, ownership_type)
           VALUES ($1, $2, 36, 'leased')`,
          [schoolA, `KL-08-${randomUUID().slice(0, 6)}`],
        ),
      ),
    ).rejects.toThrow(/vehicles_ownership_check/i);
  });

  it('stores a stop with coordinates and a default geofence radius', async () => {
    const rows = (await asSuperAdmin(async (q) =>
      q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude)
         VALUES ($1, $2, 10.026400, 76.308100) RETURNING latitude, longitude, geofence_radius_m`,
        [schoolA, `Edappally-${randomUUID().slice(0, 6)}`],
      ),
    )) as { latitude: string; longitude: string; geofence_radius_m: number }[];
    expect(Number(rows[0].latitude)).toBeCloseTo(10.0264, 4);
    expect(Number(rows[0].longitude)).toBeCloseTo(76.3081, 4);
    expect(rows[0].geofence_radius_m).toBe(150);
  });

  it('rejects a transposed coordinate pair', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.stops (school_id, name, latitude, longitude)
           VALUES ($1, $2, 76.308100, 10.026400)`,
          [schoolA, `Bad-${randomUUID().slice(0, 6)}`],
        ),
      ),
    ).rejects.toThrow(/stops_latitude_check/i);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
    await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, ['']);
    const vehicles = await runner.query(`SELECT id FROM transport.vehicles`);
    const stops = await runner.query(`SELECT id FROM transport.stops`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(vehicles).toEqual([]);
    expect(stops).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-vehicles-and-stops`
Expected: FAIL — `relation "transport.vehicles" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030800000-CreateVehiclesAndStops.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateVehiclesAndStops1757030800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE transport.vehicles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        registration_number text NOT NULL,
        capacity integer NOT NULL,
        ownership_type text NOT NULL DEFAULT 'school_owned',
        operator_name text,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vehicles_ownership_check
          CHECK (ownership_type IN ('school_owned', 'contracted', 'other')),
        CONSTRAINT vehicles_status_check CHECK (status IN ('active', 'maintenance', 'retired')),
        CONSTRAINT vehicles_capacity_check CHECK (capacity > 0),
        CONSTRAINT vehicles_registration_unique UNIQUE (school_id, registration_number)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE transport.stops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        name text NOT NULL,
        latitude numeric(9,6) NOT NULL,
        longitude numeric(9,6) NOT NULL,
        geofence_radius_m integer NOT NULL DEFAULT 150,
        special_instructions text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stops_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT stops_longitude_check CHECK (longitude BETWEEN -180 AND 180),
        CONSTRAINT stops_geofence_check CHECK (geofence_radius_m > 0)
      )
    `);

    for (const table of ['vehicles', 'stops']) {
      await queryRunner.query(`CREATE INDEX ${table}_school_id_idx ON transport.${table} (school_id)`);
      await queryRunner.query(`ALTER TABLE transport.${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE transport.${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_all ON transport.${table}
          FOR ALL
          USING (
            current_setting('app.is_super_admin', true) = 'true'
            OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
          )
          WITH CHECK (
            current_setting('app.is_super_admin', true) = 'true'
            OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
          )
      `);
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON transport.${table} TO ${appRole}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS transport.stops`);
    await queryRunner.query(`DROP TABLE IF EXISTS transport.vehicles`);
  }
}
```

The loop is safe: `table` iterates a hardcoded literal array, never a caller-supplied value.

The latitude and longitude CHECKs exist because a transposed pair — 76, 10 instead of 10, 76 — is the most common coordinate entry mistake, and without the constraint it would sit undetected until Sub-project 3 tried to route a bus into the Arabian Sea.

- [ ] **Step 4: Write the entities**

`apps/api/src/entities/vehicle.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type VehicleOwnership = 'school_owned' | 'contracted' | 'other';
export type VehicleStatus = 'active' | 'maintenance' | 'retired';

@Entity({ schema: 'transport', name: 'vehicles' })
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ name: 'registration_number', type: 'text' })
  registrationNumber: string;

  @Column({ type: 'integer' })
  capacity: number;

  @Column({ name: 'ownership_type', type: 'text' })
  ownershipType: VehicleOwnership;

  @Column({ name: 'operator_name', type: 'text', nullable: true })
  operatorName: string | null;

  @Column({ type: 'text' })
  status: VehicleStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

`apps/api/src/entities/stop.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'transport', name: 'stops' })
export class Stop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ type: 'text' })
  name: string;

  // numeric(9,6) is returned by pg as a string to preserve precision;
  // the response DTO converts it for the wire.
  @Column({ type: 'numeric', precision: 9, scale: 6 })
  latitude: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  longitude: string;

  @Column({ name: 'geofence_radius_m', type: 'integer' })
  geofenceRadiusM: number;

  @Column({ name: 'special_instructions', type: 'text', nullable: true })
  specialInstructions: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-vehicles-and-stops`
Expected: PASS, 5 tests. Then the full suite twice, green both times.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1757030800000-CreateVehiclesAndStops.ts \
        apps/api/src/database/migrations/create-vehicles-and-stops.spec.ts \
        apps/api/src/entities/vehicle.entity.ts apps/api/src/entities/stop.entity.ts
git commit -m "feat: add vehicles and stops tables with tenant RLS"
```
