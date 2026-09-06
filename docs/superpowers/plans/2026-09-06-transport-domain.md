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

---

### Task 4: `transport.routes` and `transport.route_stops`

**Files:**
- Create: `apps/api/src/database/migrations/1757030900000-CreateRoutesAndRouteStops.ts`
- Create: `apps/api/src/entities/route.entity.ts`, `apps/api/src/entities/route-stop.entity.ts`
- Test: `apps/api/src/database/migrations/create-routes-and-route-stops.spec.ts`

**Interfaces:**
- Consumes: `transport.vehicles`, `transport.stops`, `core.users`, `core.schools`.
- Produces: `transport.routes`, `transport.route_stops`; entities `Route` (`id, schoolId, name, description, defaultVehicleId, defaultDriverUserId, defaultAttendantUserId, status, createdAt, updatedAt`; `RouteStatus = 'active' | 'inactive'`) and `RouteStop` (`id, schoolId, routeId, stopId, sequence, expectedOffsetMinutes, createdAt`). **Task 6 reads `routes.default_driver_user_id` and `default_attendant_user_id` to scope drivers and attendants.**

`route_stops` has no `updated_at`: rows are immutable, and the only way to change a route's composition is the atomic replacement in Task 13.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-routes-and-route-stops.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('CreateRoutesAndRouteStops migration', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let routeA: string;
  let stopOne: string;
  let stopTwo: string;

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
      const s = (await q(`INSERT INTO core.schools (name) VALUES ('R-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolA = s[0].id;
      const r = (await q(
        `INSERT INTO transport.routes (school_id, name) VALUES ($1, $2) RETURNING id`,
        [schoolA, `Route-${randomUUID().slice(0, 6)}`],
      )) as { id: string }[];
      routeA = r[0].id;
      const s1 = (await q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude)
         VALUES ($1, $2, 10.02, 76.30) RETURNING id`,
        [schoolA, `S1-${randomUUID().slice(0, 6)}`],
      )) as { id: string }[];
      const s2 = (await q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude)
         VALUES ($1, $2, 10.03, 76.31) RETURNING id`,
        [schoolA, `S2-${randomUUID().slice(0, 6)}`],
      )) as { id: string }[];
      stopOne = s1[0].id;
      stopTwo = s2[0].id;
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('orders stops along a route', async () => {
    await asSuperAdmin(async (q) => {
      await q(
        `INSERT INTO transport.route_stops (school_id, route_id, stop_id, sequence, expected_offset_minutes)
         VALUES ($1, $2, $3, 1, 0), ($1, $2, $4, 2, 12)`,
        [schoolA, routeA, stopOne, stopTwo],
      );
    });

    const rows = (await asSuperAdmin(async (q) =>
      q(`SELECT sequence FROM transport.route_stops WHERE route_id = $1 ORDER BY sequence`, [routeA]),
    )) as { sequence: number }[];
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
  });

  it('rejects two stops sharing one position on a route', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.route_stops (school_id, route_id, stop_id, sequence, expected_offset_minutes)
           VALUES ($1, $2, $3, 1, 5)`,
          [schoolA, routeA, stopTwo],
        ),
      ),
    ).rejects.toThrow(/route_stops_sequence_unique/i);
  });

  it('rejects the same stop appearing twice on one route', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.route_stops (school_id, route_id, stop_id, sequence, expected_offset_minutes)
           VALUES ($1, $2, $3, 3, 20)`,
          [schoolA, routeA, stopOne],
        ),
      ),
    ).rejects.toThrow(/route_stops_stop_unique/i);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
    await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, ['']);
    const routes = await runner.query(`SELECT id FROM transport.routes`);
    const routeStops = await runner.query(`SELECT id FROM transport.route_stops`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(routes).toEqual([]);
    expect(routeStops).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-routes-and-route-stops`
Expected: FAIL — `relation "transport.routes" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030900000-CreateRoutesAndRouteStops.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateRoutesAndRouteStops1757030900000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE transport.routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        name text NOT NULL,
        description text,
        default_vehicle_id uuid REFERENCES transport.vehicles(id),
        default_driver_user_id uuid REFERENCES core.users(id),
        default_attendant_user_id uuid REFERENCES core.users(id),
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT routes_status_check CHECK (status IN ('active', 'inactive')),
        CONSTRAINT routes_name_unique UNIQUE (school_id, name)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX routes_default_driver_idx ON transport.routes (default_driver_user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX routes_default_attendant_idx ON transport.routes (default_attendant_user_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE transport.route_stops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        route_id uuid NOT NULL REFERENCES transport.routes(id),
        stop_id uuid NOT NULL REFERENCES transport.stops(id),
        sequence integer NOT NULL,
        expected_offset_minutes integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT route_stops_sequence_check CHECK (sequence > 0),
        CONSTRAINT route_stops_offset_check CHECK (expected_offset_minutes >= 0),
        CONSTRAINT route_stops_sequence_unique UNIQUE (route_id, sequence),
        CONSTRAINT route_stops_stop_unique UNIQUE (route_id, stop_id)
      )
    `);

    for (const table of ['routes', 'route_stops']) {
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
    await queryRunner.query(`DROP TABLE IF EXISTS transport.route_stops`);
    await queryRunner.query(`DROP TABLE IF EXISTS transport.routes`);
  }
}
```

The indexes on `default_driver_user_id` and `default_attendant_user_id` exist because Task 6 queries routes by exactly those columns on every request from a driver or attendant.

- [ ] **Step 4: Write the entities**

`apps/api/src/entities/route.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type RouteStatus = 'active' | 'inactive';

@Entity({ schema: 'transport', name: 'routes' })
export class Route {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'default_vehicle_id', type: 'uuid', nullable: true })
  defaultVehicleId: string | null;

  @Column({ name: 'default_driver_user_id', type: 'uuid', nullable: true })
  defaultDriverUserId: string | null;

  @Column({ name: 'default_attendant_user_id', type: 'uuid', nullable: true })
  defaultAttendantUserId: string | null;

  @Column({ type: 'text' })
  status: RouteStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

`apps/api/src/entities/route-stop.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'transport', name: 'route_stops' })
export class RouteStop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ name: 'route_id', type: 'uuid' })
  routeId: string;

  @Column({ name: 'stop_id', type: 'uuid' })
  stopId: string;

  @Column({ type: 'integer' })
  sequence: number;

  @Column({ name: 'expected_offset_minutes', type: 'integer' })
  expectedOffsetMinutes: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-routes-and-route-stops`
Expected: PASS, 4 tests. Then the full suite twice, green both times.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1757030900000-CreateRoutesAndRouteStops.ts \
        apps/api/src/database/migrations/create-routes-and-route-stops.spec.ts \
        apps/api/src/entities/route.entity.ts apps/api/src/entities/route-stop.entity.ts
git commit -m "feat: add routes and route_stops tables with tenant RLS"
```

---

### Task 5: `transport.student_route_assignments`

**Files:**
- Create: `apps/api/src/database/migrations/1757031000000-CreateStudentRouteAssignments.ts`
- Create: `apps/api/src/entities/student-route-assignment.entity.ts`
- Test: `apps/api/src/database/migrations/create-student-route-assignments.spec.ts`

**Interfaces:**
- Consumes: `transport.students`, `transport.routes`, `transport.stops`.
- Produces: `transport.student_route_assignments`; entity `StudentRouteAssignment` (`id, schoolId, studentId, routeId, stopId, direction, effectiveFrom, effectiveTo, createdAt, updatedAt`) and `AssignmentDirection = 'morning' | 'afternoon' | 'both'`. **Task 6 joins this table to scope drivers to the students on their routes.**

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-student-route-assignments.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('CreateStudentRouteAssignments migration', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let studentA: string;
  let routeA: string;
  let stopA: string;

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
      const s = (await q(`INSERT INTO core.schools (name) VALUES ('AS-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolA = s[0].id;
      const st = (await q(
        `INSERT INTO transport.students (school_id, admission_number, full_name, grade)
         VALUES ($1, $2, 'Child', '5') RETURNING id`,
        [schoolA, `ADM-${randomUUID()}`],
      )) as { id: string }[];
      studentA = st[0].id;
      const r = (await q(
        `INSERT INTO transport.routes (school_id, name) VALUES ($1, $2) RETURNING id`,
        [schoolA, `Route-${randomUUID().slice(0, 6)}`],
      )) as { id: string }[];
      routeA = r[0].id;
      const sp = (await q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude)
         VALUES ($1, $2, 10.02, 76.30) RETURNING id`,
        [schoolA, `Stop-${randomUUID().slice(0, 6)}`],
      )) as { id: string }[];
      stopA = sp[0].id;
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('assigns a student to a stop on a route for a direction', async () => {
    const rows = (await asSuperAdmin(async (q) =>
      q(
        `INSERT INTO transport.student_route_assignments
           (school_id, student_id, route_id, stop_id, direction, effective_from)
         VALUES ($1, $2, $3, $4, 'both', CURRENT_DATE) RETURNING direction, effective_to`,
        [schoolA, studentA, routeA, stopA],
      ),
    )) as { direction: string; effective_to: string | null }[];
    expect(rows[0]).toEqual({ direction: 'both', effective_to: null });
  });

  it('rejects an unknown direction', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.student_route_assignments
             (school_id, student_id, route_id, stop_id, direction, effective_from)
           VALUES ($1, $2, $3, $4, 'evening', CURRENT_DATE)`,
          [schoolA, studentA, routeA, stopA],
        ),
      ),
    ).rejects.toThrow(/assignments_direction_check/i);
  });

  it('rejects an end date before the start date', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.student_route_assignments
             (school_id, student_id, route_id, stop_id, direction, effective_from, effective_to)
           VALUES ($1, $2, $3, $4, 'morning', CURRENT_DATE, CURRENT_DATE - 1)`,
          [schoolA, studentA, routeA, stopA],
        ),
      ),
    ).rejects.toThrow(/assignments_date_order_check/i);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
    await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, ['']);
    const rows = await runner.query(`SELECT id FROM transport.student_route_assignments`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-student-route-assignments`
Expected: FAIL — `relation "transport.student_route_assignments" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757031000000-CreateStudentRouteAssignments.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateStudentRouteAssignments1757031000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE transport.student_route_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        student_id uuid NOT NULL REFERENCES transport.students(id),
        route_id uuid NOT NULL REFERENCES transport.routes(id),
        stop_id uuid NOT NULL REFERENCES transport.stops(id),
        direction text NOT NULL,
        effective_from date NOT NULL,
        effective_to date,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT assignments_direction_check
          CHECK (direction IN ('morning', 'afternoon', 'both')),
        CONSTRAINT assignments_date_order_check
          CHECK (effective_to IS NULL OR effective_to >= effective_from)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX assignments_student_idx ON transport.student_route_assignments (student_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX assignments_route_idx ON transport.student_route_assignments (route_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX assignments_school_id_idx ON transport.student_route_assignments (school_id)`,
    );

    await queryRunner.query(`ALTER TABLE transport.student_route_assignments ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE transport.student_route_assignments FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY assignments_tenant_all ON transport.student_route_assignments
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
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON transport.student_route_assignments TO ${appRole}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS transport.student_route_assignments`);
  }
}
```

There is deliberately **no** unique constraint on `(student_id, route_id, direction)`. A student legitimately has overlapping historical rows — one ended assignment and one current — and the date range, not uniqueness, is what distinguishes them. Task 14 enforces "at most one *active* assignment per direction" in the service, where the dates can be consulted.

- [ ] **Step 4: Write the entity**

`apps/api/src/entities/student-route-assignment.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type AssignmentDirection = 'morning' | 'afternoon' | 'both';

@Entity({ schema: 'transport', name: 'student_route_assignments' })
export class StudentRouteAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ name: 'student_id', type: 'uuid' })
  studentId: string;

  @Column({ name: 'route_id', type: 'uuid' })
  routeId: string;

  @Column({ name: 'stop_id', type: 'uuid' })
  stopId: string;

  @Column({ type: 'text' })
  direction: AssignmentDirection;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- create-student-route-assignments`
Expected: PASS, 4 tests. Then the full suite twice, green both times.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1757031000000-CreateStudentRouteAssignments.ts \
        apps/api/src/database/migrations/create-student-route-assignments.spec.ts \
        apps/api/src/entities/student-route-assignment.entity.ts
git commit -m "feat: add student_route_assignments with date ranges and tenant RLS"
```

---

### Task 6: `AbacScopeService` — the role-attribute access layer

**Files:**
- Create: `apps/api/src/transport/abac/abac-scope.service.ts`
- Test: `apps/api/src/transport/abac/abac-scope.service.spec.ts`

**Interfaces:**
- Consumes: `TenantContextService.getManager()` from `src/tenancy/tenant-context.service`; `AccessTokenClaims` from `src/auth/token.service`; entities `StudentGuardian`, `Route`, `StudentRouteAssignment`.
- Produces: `AbacScopeService` with two methods that every later task depends on:
  - `visibleStudentIds(claims: AccessTokenClaims): Promise<StudentScope>` where `type StudentScope = { kind: 'all' } | { kind: 'restricted'; studentIds: string[] }`
  - `assertCanReadStudent(claims: AccessTokenClaims, studentId: string): Promise<void>` — throws `ForbiddenException` when out of scope.

**Why this task exists, and why it is separate.** Foundations' Row-Level Security is a *tenant* boundary and never a role boundary: `users_tenant_all` is `FOR ALL`, so at the database layer any authenticated session already has full rights over its own school's rows. Every `transport` table follows that same pattern. So RLS alone would let a **parent see every student in their school**. This service is the only thing standing between a parent and another family's children, and it is deliberately in one file so that rule can be read and tested in one place rather than re-derived in each module.

`{ kind: 'all' }` and `{ kind: 'restricted' }` are distinguished rather than returning a plain array, because "no restriction" and "restricted to an empty set" must not be confused. A parent with no linked children sees nothing; a school_admin sees everything. Collapsing both to `string[]` makes the empty array ambiguous and is exactly the kind of silent widening this layer exists to prevent.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/abac/abac-scope.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { AbacScopeService } from './abac-scope.service';

describe('AbacScopeService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: AbacScopeService;

  let schoolId: string;
  let ownChild: string;
  let otherChild: string;
  let parentId: string;
  let driverId: string;

  const claimsFor = (role: AccessTokenClaims['role'], sub: string): AccessTokenClaims => ({
    sub,
    schoolId,
    role,
    isSuperAdmin: role === 'super_admin',
  });

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new AbacScopeService(tenantContextService);

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const runId = randomUUID();

      const [school] = (await manager.query(
        `INSERT INTO core.schools (name) VALUES ($1) RETURNING id`,
        [`ABAC-${runId}`],
      )) as { id: string }[];
      schoolId = school.id;

      const [parent] = (await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'parent', $2, 'x', 'Parent') RETURNING id`,
        [schoolId, `abac-parent-${runId}@example.com`],
      )) as { id: string }[];
      parentId = parent.id;

      const [driver] = (await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'driver', $2, 'x', 'Driver') RETURNING id`,
        [schoolId, `abac-driver-${runId}@example.com`],
      )) as { id: string }[];
      driverId = driver.id;

      const [own] = (await manager.query(
        `INSERT INTO transport.students (school_id, admission_number, full_name, grade)
         VALUES ($1, $2, 'Own Child', '5') RETURNING id`,
        [schoolId, `OWN-${runId}`],
      )) as { id: string }[];
      ownChild = own.id;

      const [other] = (await manager.query(
        `INSERT INTO transport.students (school_id, admission_number, full_name, grade)
         VALUES ($1, $2, 'Other Child', '5') RETURNING id`,
        [schoolId, `OTHER-${runId}`],
      )) as { id: string }[];
      otherChild = other.id;

      // Only ownChild is linked to the parent. otherChild is in the SAME school,
      // so RLS alone would expose it — that is the point of these tests.
      await manager.query(
        `INSERT INTO transport.student_guardians (school_id, student_id, guardian_user_id, relationship)
         VALUES ($1, $2, $3, 'mother')`,
        [schoolId, ownChild, parentId],
      );

      const [route] = (await manager.query(
        `INSERT INTO transport.routes (school_id, name, default_driver_user_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [schoolId, `ABAC-Route-${runId}`, driverId],
      )) as { id: string }[];

      const [stop] = (await manager.query(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude)
         VALUES ($1, $2, 10.02, 76.30) RETURNING id`,
        [schoolId, `ABAC-Stop-${runId}`],
      )) as { id: string }[];

      // Only ownChild rides the driver's route.
      await manager.query(
        `INSERT INTO transport.student_route_assignments
           (school_id, student_id, route_id, stop_id, direction, effective_from)
         VALUES ($1, $2, $3, $4, 'both', CURRENT_DATE)`,
        [schoolId, ownChild, route.id, stop.id],
      );
    });
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const inTenant = <T>(claims: AccessTokenClaims, work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(claims, work);

  it('places no restriction on a school_admin', async () => {
    const claims = claimsFor('school_admin', randomUUID());
    const scope = await inTenant(claims, () => service.visibleStudentIds(claims));
    expect(scope).toEqual({ kind: 'all' });
  });

  it('places no restriction on a super_admin', async () => {
    const claims: AccessTokenClaims = { sub: randomUUID(), schoolId: null, role: 'super_admin', isSuperAdmin: true };
    const scope = await inTenant(claims, () => service.visibleStudentIds(claims));
    expect(scope).toEqual({ kind: 'all' });
  });

  it('restricts a parent to their linked children only', async () => {
    const claims = claimsFor('parent', parentId);
    const scope = await inTenant(claims, () => service.visibleStudentIds(claims));

    expect(scope.kind).toBe('restricted');
    if (scope.kind !== 'restricted') throw new Error('expected a restricted scope');
    expect(scope.studentIds).toEqual([ownChild]);
    // The decisive assertion: another child in the SAME school is excluded.
    expect(scope.studentIds).not.toContain(otherChild);
  });

  it('restricts a driver to students on the routes they drive', async () => {
    const claims = claimsFor('driver', driverId);
    const scope = await inTenant(claims, () => service.visibleStudentIds(claims));

    expect(scope.kind).toBe('restricted');
    if (scope.kind !== 'restricted') throw new Error('expected a restricted scope');
    expect(scope.studentIds).toEqual([ownChild]);
    expect(scope.studentIds).not.toContain(otherChild);
  });

  it('gives a parent with no linked children an empty restricted scope, not unrestricted access', async () => {
    const claims = claimsFor('parent', randomUUID());
    const scope = await inTenant(claims, () => service.visibleStudentIds(claims));

    expect(scope).toEqual({ kind: 'restricted', studentIds: [] });
  });

  it('allows a parent to read their own child', async () => {
    const claims = claimsFor('parent', parentId);
    await expect(inTenant(claims, () => service.assertCanReadStudent(claims, ownChild))).resolves.toBeUndefined();
  });

  it('forbids a parent from reading another family child in the same school', async () => {
    const claims = claimsFor('parent', parentId);
    await expect(inTenant(claims, () => service.assertCanReadStudent(claims, otherChild))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- abac-scope`
Expected: FAIL — `Cannot find module './abac-scope.service'`.

- [ ] **Step 3: Write the service**

`apps/api/src/transport/abac/abac-scope.service.ts`:
```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AccessTokenClaims } from '../../auth/token.service';

/**
 * Which students a caller may see.
 *
 * `all` and `restricted` are distinguished rather than collapsed into an array
 * because "no restriction" and "restricted to nothing" are opposite outcomes.
 * A parent with no linked children must see nothing; a school_admin sees
 * everything. If both were `string[]`, an empty array would be ambiguous and a
 * caller that treated "empty means unfiltered" would silently expose the whole
 * school.
 */
export type StudentScope = { kind: 'all' } | { kind: 'restricted'; studentIds: string[] };

@Injectable()
export class AbacScopeService {
  constructor(private readonly tenantContextService: TenantContextService) {}

  /**
   * Row-Level Security already confines every query to the caller's school.
   * This narrows further, by role attribute, to the students that role may see
   * *within* that school — the layer RLS deliberately does not provide.
   */
  async visibleStudentIds(claims: AccessTokenClaims): Promise<StudentScope> {
    if (claims.isSuperAdmin || claims.role === 'school_admin') {
      return { kind: 'all' };
    }

    const manager = this.tenantContextService.getManager();

    if (claims.role === 'parent') {
      const rows = (await manager.query(
        `SELECT student_id FROM transport.student_guardians WHERE guardian_user_id = $1 ORDER BY student_id`,
        [claims.sub],
      )) as { student_id: string }[];
      return { kind: 'restricted', studentIds: rows.map((row) => row.student_id) };
    }

    if (claims.role === 'driver' || claims.role === 'attendant') {
      const column =
        claims.role === 'driver' ? 'default_driver_user_id' : 'default_attendant_user_id';
      const rows = (await manager.query(
        `SELECT DISTINCT a.student_id
           FROM transport.student_route_assignments a
           JOIN transport.routes r ON r.id = a.route_id
          WHERE r.${column} = $1
            AND a.effective_from <= CURRENT_DATE
            AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)
          ORDER BY a.student_id`,
        [claims.sub],
      )) as { student_id: string }[];
      return { kind: 'restricted', studentIds: rows.map((row) => row.student_id) };
    }

    // Any role not enumerated above sees nothing. Failing closed matters more
    // than convenience: a role added later must be considered deliberately
    // rather than inheriting access by omission.
    return { kind: 'restricted', studentIds: [] };
  }

  async assertCanReadStudent(claims: AccessTokenClaims, studentId: string): Promise<void> {
    const scope = await this.visibleStudentIds(claims);
    if (scope.kind === 'all') {
      return;
    }
    if (!scope.studentIds.includes(studentId)) {
      throw new ForbiddenException('Student is not within your access scope');
    }
  }
}
```

Two details that are load-bearing rather than stylistic:

The `column` value is chosen by a closed ternary over two literals, never interpolated from anything caller-supplied — the only safe way to vary an identifier in SQL, since Postgres offers no parameter binding for column names.

The driver query filters on the assignment's date range. A driver must see the students riding their route **today**, not everyone who ever rode it. Omitting the date predicate would quietly widen a driver's view to every student ever assigned, which is precisely the kind of drift the date columns exist to prevent.

- [ ] **Step 4: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- abac-scope`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the tests bite**

This is the most important verification in the sub-project. Temporarily change `visibleStudentIds` so the `parent` branch returns `{ kind: 'all' }`, then re-run the focused suite. Expect the parent-restriction test and the `assertCanReadStudent` forbidden test to **fail**. Restore the correct code and confirm they pass again.

Record both outputs in your report. A scoping test that would still pass with the scoping removed is worse than no test, because it looks like protection — and that exact failure mode was found repeatedly during Foundations.

- [ ] **Step 6: Run the full suite and commit**

Run the full suite twice; both green. Then:

```bash
git add apps/api/src/transport/abac/abac-scope.service.ts \
        apps/api/src/transport/abac/abac-scope.service.spec.ts
git commit -m "feat: add ABAC scope service narrowing student visibility by role"
```

---

### Task 7: `StudentsService` and its DTOs

**Files:**
- Create: `apps/api/src/transport/students/students.service.ts`
- Create: `apps/api/src/transport/students/dto/create-student.dto.ts`
- Create: `apps/api/src/transport/students/dto/update-student.dto.ts`
- Create: `apps/api/src/transport/students/dto/student-response.dto.ts`
- Test: `apps/api/src/transport/students/students.service.spec.ts`

**Interfaces:**
- Consumes: `TenantContextService.getManager()`; `AuditService.record()`; `AbacScopeService.visibleStudentIds` / `assertCanReadStudent` (Task 6); the `Student` entity and `StudentStatus` type (Task 1); `AccessTokenClaims`.
- Produces:
  - `StudentsService` with `create(claims, dto): Promise<Student>`, `findById(claims, id): Promise<Student>`, `findAll(claims, limit, offset): Promise<Page<Student>>`, `update(claims, id, dto): Promise<Student>`
  - `interface Page<T> { items: T[]; total: number }` — the same shape `SchoolsService` exports, redeclared here so the transport modules do not import from `src/schools/`
  - `CreateStudentDto`, `UpdateStudentDto`, `StudentResponseDto`, `toStudentResponse(student: Student): StudentResponseDto`

**Why the service and not the controller owns scoping.** The controller decides *which roles may call an endpoint*; the service decides *which rows that caller may see*. Keeping the second decision in the service means Task 14's assignment endpoints get the same narrowing for free instead of re-implementing it, and it means the scoping tests can run without an HTTP layer.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/students/students.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { AbacScopeService } from '../abac/abac-scope.service';
import { StudentsService } from './students.service';

describe('StudentsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: StudentsService;

  let schoolId: string;
  let otherSchoolId: string;
  let adminId: string;
  let parentId: string;
  let ownChildId: string;

  const admissionNumber = `ADM-${randomUUID().slice(0, 8)}`;

  const claimsFor = (
    role: AccessTokenClaims['role'],
    sub: string,
    school: string = schoolId,
  ): AccessTokenClaims => ({
    sub,
    schoolId: school,
    role,
    isSuperAdmin: false,
  });

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new StudentsService(
      tenantContextService,
      new AuditService(tenantContextService),
      new AbacScopeService(tenantContextService),
    );

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Students Service School') RETURNING id`,
      );
      const [other] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Students Service Other School') RETURNING id`,
      );
      schoolId = school.id;
      otherSchoolId = other.id;

      const [admin] = await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'school_admin', $2, 'x', 'Admin') RETURNING id`,
        [schoolId, `students-admin-${randomUUID()}@example.com`],
      );
      const [parent] = await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'parent', $2, 'x', 'Parent') RETURNING id`,
        [schoolId, `students-parent-${randomUUID()}@example.com`],
      );
      adminId = admin.id;
      parentId = parent.id;
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('creates a student and audits the creation', async () => {
    const created = await tenantContextService.runWithTenant(
      claimsFor('school_admin', adminId),
      () =>
        service.create(claimsFor('school_admin', adminId), {
          admissionNumber,
          fullName: 'Aarav Nair',
          grade: '5',
          section: 'B',
        }),
    );

    expect(created.id).toBeDefined();
    expect(created.status).toBe('active');
    expect(created.section).toBe('B');
    expect(created.dateOfBirth).toBeNull();
    ownChildId = created.id;

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(
          `SELECT action, entity_type, entity_id, actor_user_id, school_id
             FROM audit.audit_logs WHERE entity_id = $1`,
          [created.id],
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'student.created',
      entity_type: 'student',
      entity_id: created.id,
      actor_user_id: adminId,
      school_id: schoolId,
    });
  });

  it('rejects a duplicate admission number within the same school', async () => {
    await expect(
      tenantContextService.runWithTenant(claimsFor('school_admin', adminId), () =>
        service.create(claimsFor('school_admin', adminId), {
          admissionNumber,
          fullName: 'Impostor',
          grade: '5',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts the same admission number in a different school', async () => {
    const [otherAdmin] = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ($1, 'school_admin', $2, 'x', 'Other Admin') RETURNING id`,
          [otherSchoolId, `students-other-admin-${randomUUID()}@example.com`],
        ),
    );

    const created = await tenantContextService.runWithTenant(
      claimsFor('school_admin', otherAdmin.id, otherSchoolId),
      () =>
        service.create(claimsFor('school_admin', otherAdmin.id, otherSchoolId), {
          admissionNumber,
          fullName: 'Same Number Elsewhere',
          grade: '5',
        }),
    );

    expect(created.schoolId).toBe(otherSchoolId);
  });

  it('lists every student in the school for a school_admin', async () => {
    const page = await tenantContextService.runWithTenant(
      claimsFor('school_admin', adminId),
      () => service.findAll(claimsFor('school_admin', adminId), 50, 0),
    );

    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.items.map((student) => student.id)).toContain(ownChildId);
  });

  it('lists nothing for a parent with no linked children', async () => {
    const page = await tenantContextService.runWithTenant(claimsFor('parent', parentId), () =>
      service.findAll(claimsFor('parent', parentId), 50, 0),
    );

    expect(page).toEqual({ items: [], total: 0 });
  });

  it('refuses to read a student outside the caller scope', async () => {
    await expect(
      tenantContextService.runWithTenant(claimsFor('parent', parentId), () =>
        service.findById(claimsFor('parent', parentId), ownChildId),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates a student and audits the update', async () => {
    const updated = await tenantContextService.runWithTenant(
      claimsFor('school_admin', adminId),
      () =>
        service.update(claimsFor('school_admin', adminId), ownChildId, { grade: '6', section: null }),
    );

    expect(updated.grade).toBe('6');
    expect(updated.section).toBeNull();
    expect(updated.admissionNumber).toBe(admissionNumber);

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
          ownChildId,
        ]),
    );
    expect(rows.map((row: { action: string }) => row.action)).toEqual([
      'student.created',
      'student.updated',
    ]);
  });

  it('audits a status change to inactive as a deactivation, not an update', async () => {
    await tenantContextService.runWithTenant(claimsFor('school_admin', adminId), () =>
      service.update(claimsFor('school_admin', adminId), ownChildId, { status: 'inactive' }),
    );

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
          ownChildId,
        ]),
    );
    expect(rows.map((row: { action: string }) => row.action)).toEqual([
      'student.created',
      'student.updated',
      'student.deactivated',
    ]);
  });

  it('raises NotFound when updating a student that does not exist', async () => {
    await expect(
      tenantContextService.runWithTenant(claimsFor('school_admin', adminId), () =>
        service.update(claimsFor('school_admin', adminId), randomUUID(), { grade: '9' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Note the shape of the duplicate-admission-number test. It runs the failing `create` inside its **own** `runWithTenant`, not appended to the successful one. A unique violation aborts the enclosing Postgres transaction, so every subsequent statement in that transaction fails with `current transaction is aborted`. Sharing one transaction between the success and the conflict would produce a passing test for the wrong reason.

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- students.service`
Expected: FAIL — `Cannot find module './students.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/students/dto/create-student.dto.ts`:
```ts
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateStudentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  admissionNumber: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  grade: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  section?: string;

  // A date-only ISO string. The column is `date`, and TypeORM hands `date`
  // columns back as strings, so keeping the DTO a string avoids a timezone
  // round-trip that could shift a birthday by a day.
  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;
}
```

`apps/api/src/transport/students/dto/update-student.dto.ts`:
```ts
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { StudentStatus } from '../../../entities/student.entity';

// `admissionNumber` is deliberately absent. It is the school's own key for the
// child and appears on records this system does not own; changing it through a
// PATCH would silently break the correspondence. A genuine correction is rare
// enough to be worth its own endpoint later.
export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  grade?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  section?: string | null;

  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string | null;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: StudentStatus;
}
```

`apps/api/src/transport/students/dto/student-response.dto.ts`:
```ts
import { Student, StudentStatus } from '../../../entities/student.entity';

// An explicit allow-list, following the `toUserResponse` pattern Foundations
// established: a column added to the entity later is not exposed by accident.
export interface StudentResponseDto {
  id: string;
  admissionNumber: string;
  fullName: string;
  grade: string;
  section: string | null;
  dateOfBirth: string | null;
  status: StudentStatus;
}

export function toStudentResponse(student: Student): StudentResponseDto {
  return {
    id: student.id,
    admissionNumber: student.admissionNumber,
    fullName: student.fullName,
    grade: student.grade,
    section: student.section,
    dateOfBirth: student.dateOfBirth,
    status: student.status,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/students/students.service.ts`:
```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { In } from 'typeorm';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { Student } from '../../entities/student.entity';
import { AbacScopeService } from '../abac/abac-scope.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * Every write here needs a school to write into. A `super_admin` token carries
 * `schoolId: null`, so it cannot create school-scoped rows; the controller's
 * `@Roles('school_admin')` already prevents that call, and this check makes the
 * invariant explicit rather than letting a null reach the database.
 */
export function requireSchoolId(claims: AccessTokenClaims): string {
  if (!claims.schoolId) {
    throw new BadRequestException('This operation requires a school-scoped account');
  }
  return claims.schoolId;
}

/**
 * Turns a Postgres unique violation into a 409 and leaves every other error
 * untouched, so an unexpected database failure still reaches the global filter
 * as a 500 rather than being mislabelled a client mistake.
 */
export function asConflict(error: unknown, message: string): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  ) {
    return new ConflictException(message);
  }
  return error;
}

@Injectable()
export class StudentsService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
    private readonly abacScopeService: AbacScopeService,
  ) {}

  async create(claims: AccessTokenClaims, dto: CreateStudentDto): Promise<Student> {
    const schoolId = requireSchoolId(claims);
    const manager = this.tenantContextService.getManager();

    let student: Student;
    try {
      student = await manager.getRepository(Student).save({
        schoolId,
        admissionNumber: dto.admissionNumber,
        fullName: dto.fullName,
        grade: dto.grade,
        section: dto.section ?? null,
        dateOfBirth: dto.dateOfBirth ?? null,
        status: 'active' as const,
      });
    } catch (error) {
      throw asConflict(error, 'A student with that admission number already exists');
    }

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'student.created',
      entityType: 'student',
      entityId: student.id,
    });

    return student;
  }

  /**
   * The scope check runs before the existence check on purpose: an out-of-scope
   * caller gets 403 for a real id and 403 for a made-up one alike, so the
   * response never confirms that a given student exists.
   */
  async findById(claims: AccessTokenClaims, id: string): Promise<Student> {
    await this.abacScopeService.assertCanReadStudent(claims, id);
    const manager = this.tenantContextService.getManager();
    const student = await manager.getRepository(Student).findOne({ where: { id } });
    if (!student) {
      throw new NotFoundException('Student not found');
    }
    return student;
  }

  async findAll(
    claims: AccessTokenClaims,
    limit: number,
    offset: number,
  ): Promise<Page<Student>> {
    const scope = await this.abacScopeService.visibleStudentIds(claims);
    const repository = this.tenantContextService.getManager().getRepository(Student);
    const order = { admissionNumber: 'ASC' } as const;

    if (scope.kind === 'all') {
      const [items, total] = await repository.findAndCount({ take: limit, skip: offset, order });
      return { items, total };
    }

    // An empty restricted scope short-circuits rather than reaching the
    // database: `In([])` is not a reliable "match nothing" across TypeORM
    // versions, and getting that wrong here would show a parent with no linked
    // children every student in the school.
    if (scope.studentIds.length === 0) {
      return { items: [], total: 0 };
    }

    const [items, total] = await repository.findAndCount({
      where: { id: In(scope.studentIds) },
      take: limit,
      skip: offset,
      order,
    });
    return { items, total };
  }

  async update(
    claims: AccessTokenClaims,
    id: string,
    dto: UpdateStudentDto,
  ): Promise<Student> {
    const schoolId = requireSchoolId(claims);
    const repository = this.tenantContextService.getManager().getRepository(Student);

    const existing = await repository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Student not found');
    }

    // Fields are copied across one at a time rather than spread, because a
    // spread of the DTO would write `undefined` over any column the caller
    // simply did not mention.
    const patch: Partial<Student> = {};
    if (dto.fullName !== undefined) patch.fullName = dto.fullName;
    if (dto.grade !== undefined) patch.grade = dto.grade;
    if (dto.section !== undefined) patch.section = dto.section;
    if (dto.dateOfBirth !== undefined) patch.dateOfBirth = dto.dateOfBirth;
    if (dto.status !== undefined) patch.status = dto.status;

    const deactivating = dto.status === 'inactive' && existing.status !== 'inactive';
    const updated = await repository.save({ ...existing, ...patch });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: deactivating ? 'student.deactivated' : 'student.updated',
      entityType: 'student',
      entityId: updated.id,
    });

    return updated;
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- students.service`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the scoping test bites**

Temporarily change `findAll` so the `restricted` branch falls through to the unrestricted query, and re-run. The "lists nothing for a parent with no linked children" test must **fail**. Restore and confirm it passes. Record both outputs.

- [ ] **Step 7: Run the full suite and commit**

```bash
git add apps/api/src/transport/students/
git commit -m "feat: add students service with ABAC-scoped reads and audited mutations"
```

---

### Task 8: `StudentsController` and `StudentsModule`

**Files:**
- Create: `apps/api/src/transport/students/students.controller.ts`
- Create: `apps/api/src/transport/students/students.module.ts`
- Test: `apps/api/src/transport/students/students.controller.spec.ts`

**Interfaces:**
- Consumes: `StudentsService` and the DTOs from Task 7; `@Roles`, `@CurrentUser`, `PaginationQueryDto`, `PaginatedResponse`.
- Produces: `StudentsController` exposing `POST /students`, `GET /students`, `GET /students/:id`, `PATCH /students/:id`; `StudentsModule` importing `AuthModule`, `AuditModule` and `TransportAbacModule` (created here, exporting `AbacScopeService`), declaring `StudentsController` and providing `StudentsService`.

The ABAC provider needs its own module because Tasks 12 and 14 also consume it. Declaring it once and exporting it keeps a single instance rather than one copy per feature module.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/students/students.controller.spec.ts` — a unit test over a stubbed service, checking the controller's mapping and paging contract only. The role restrictions themselves are the `RolesGuard`'s job and are proved over HTTP in Task 16.

```ts
import { AccessTokenClaims } from '../../auth/token.service';
import { Student } from '../../entities/student.entity';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

describe('StudentsController', () => {
  const claims: AccessTokenClaims = {
    sub: 'user-1',
    schoolId: 'school-1',
    role: 'school_admin',
    isSuperAdmin: false,
  };

  const student = {
    id: 'student-1',
    schoolId: 'school-1',
    admissionNumber: 'ADM-1',
    fullName: 'Aarav Nair',
    grade: '5',
    section: 'B',
    dateOfBirth: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Student;

  const service = {
    create: jest.fn().mockResolvedValue(student),
    findAll: jest.fn().mockResolvedValue({ items: [student], total: 1 }),
    findById: jest.fn().mockResolvedValue(student),
    update: jest.fn().mockResolvedValue(student),
  } as unknown as StudentsService;

  const controller = new StudentsController(service);

  it('returns the response DTO and never the raw entity', async () => {
    const result = await controller.create(claims, {
      admissionNumber: 'ADM-1',
      fullName: 'Aarav Nair',
      grade: '5',
    });

    expect(result).toEqual({
      id: 'student-1',
      admissionNumber: 'ADM-1',
      fullName: 'Aarav Nair',
      grade: '5',
      section: 'B',
      dateOfBirth: null,
      status: 'active',
    });
    expect(result).not.toHaveProperty('schoolId');
  });

  it('echoes the requested limit and offset in the page envelope', async () => {
    const page = await controller.findAll(claims, { limit: 25, offset: 50 });

    expect(page).toEqual({ items: [expect.objectContaining({ id: 'student-1' })], total: 1, limit: 25, offset: 50 });
    expect(service.findAll).toHaveBeenCalledWith(claims, 25, 50);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- students.controller`
Expected: FAIL — `Cannot find module './students.controller'`.

- [ ] **Step 3: Write the ABAC module**

`apps/api/src/transport/abac/abac.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AbacScopeService } from './abac-scope.service';

@Module({
  providers: [AbacScopeService],
  exports: [AbacScopeService],
})
export class TransportAbacModule {}
```

- [ ] **Step 4: Write the controller and module**

`apps/api/src/transport/students/students.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../auth/token.service';
import { PaginatedResponse, PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { StudentsService } from './students.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentResponseDto, toStudentResponse } from './dto/student-response.dto';

@Controller('students')
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Roles('school_admin')
  @Post()
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateStudentDto,
  ): Promise<StudentResponseDto> {
    return toStudentResponse(await this.studentsService.create(user, dto));
  }

  // Read is open to every operational role; which rows come back is decided by
  // AbacScopeService inside the service, not by this list.
  @Roles('school_admin', 'parent', 'driver', 'attendant')
  @Get()
  async findAll(
    @CurrentUser() user: AccessTokenClaims,
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<StudentResponseDto>> {
    const { items, total } = await this.studentsService.findAll(
      user,
      pagination.limit,
      pagination.offset,
    );
    return {
      items: items.map(toStudentResponse),
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  @Roles('school_admin', 'parent', 'driver', 'attendant')
  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StudentResponseDto> {
    return toStudentResponse(await this.studentsService.findById(user, id));
  }

  @Roles('school_admin')
  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ): Promise<StudentResponseDto> {
    return toStudentResponse(await this.studentsService.update(user, id, dto));
  }
}
```

`ParseUUIDPipe` matters beyond tidiness: without it a non-UUID path parameter reaches Postgres as `'abc'::uuid` and raises `invalid input syntax for type uuid`, which the global filter can only render as a 500. With it, the caller gets the 400 the mistake deserves.

`apps/api/src/transport/students/students.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuditModule } from '../../audit/audit.module';
import { TransportAbacModule } from '../abac/abac.module';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [AuthModule, AuditModule, TransportAbacModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- students.controller`
Expected: PASS, 2 tests. Then the full suite twice, green both times.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/transport/abac/abac.module.ts apps/api/src/transport/students/
git commit -m "feat: expose students HTTP surface with role-gated endpoints"
```

---

### Task 9: Guardian links

**Files:**
- Create: `apps/api/src/transport/students/guardians.service.ts`
- Create: `apps/api/src/transport/students/dto/link-guardian.dto.ts`
- Create: `apps/api/src/transport/students/dto/guardian-response.dto.ts`
- Modify: `apps/api/src/transport/students/students.controller.ts` — add the two nested endpoints
- Modify: `apps/api/src/transport/students/students.module.ts` — provide `GuardiansService`
- Test: `apps/api/src/transport/students/guardians.service.spec.ts`

**Interfaces:**
- Consumes: `StudentGuardian` and `GuardianRelationship` (Task 2); `User` and `UserRole` from `src/entities/user.entity`; `Student` (Task 1); `requireSchoolId` and `asConflict` exported by `students.service.ts` (Task 7); `AbacScopeService`.
- Produces: `GuardiansService` with `link(claims, studentId, dto): Promise<StudentGuardian>` and `unlink(claims, studentId, guardianUserId): Promise<void>`; `LinkGuardianDto`; `GuardianResponseDto` + `toGuardianResponse`.

**Why this is a separate task.** Linking a guardian is the operation that *grants* a parent visibility of a child — it is the write side of the rule Task 6 reads. Its tests are therefore the strongest available proof that ABAC is wired to real data: link a guardian, and the parent's scope grows by exactly one student; unlink, and it shrinks back.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/students/guardians.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { AbacScopeService } from '../abac/abac-scope.service';
import { GuardiansService } from './guardians.service';

describe('GuardiansService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let abacScopeService: AbacScopeService;
  let service: GuardiansService;

  let schoolId: string;
  let adminId: string;
  let parentId: string;
  let driverId: string;
  let studentId: string;

  const adminClaims = (): AccessTokenClaims => ({
    sub: adminId,
    schoolId,
    role: 'school_admin',
    isSuperAdmin: false,
  });
  const parentClaims = (): AccessTokenClaims => ({
    sub: parentId,
    schoolId,
    role: 'parent',
    isSuperAdmin: false,
  });

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    abacScopeService = new AbacScopeService(tenantContextService);
    service = new GuardiansService(
      tenantContextService,
      new AuditService(tenantContextService),
    );

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Guardians School') RETURNING id`,
      );
      schoolId = school.id;

      const insertUser = async (role: string, name: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [schoolId, role, `guardians-${role}-${randomUUID()}@example.com`, name],
        );
        return row.id;
      };
      adminId = await insertUser('school_admin', 'Admin');
      parentId = await insertUser('parent', 'Parent');
      driverId = await insertUser('driver', 'Driver');

      const [student] = await manager.query(
        `INSERT INTO transport.students (school_id, admission_number, full_name, grade, status)
         VALUES ($1, $2, 'Meera Pillai', '3', 'active') RETURNING id`,
        [schoolId, `ADM-${randomUUID().slice(0, 8)}`],
      );
      studentId = student.id;
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('grants the parent visibility of exactly the linked child', async () => {
    const before = await tenantContextService.runWithTenant(parentClaims(), () =>
      abacScopeService.visibleStudentIds(parentClaims()),
    );
    expect(before).toEqual({ kind: 'restricted', studentIds: [] });

    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.link(adminClaims(), studentId, {
        guardianUserId: parentId,
        relationship: 'mother',
        isPrimary: true,
      }),
    );

    const after = await tenantContextService.runWithTenant(parentClaims(), () =>
      abacScopeService.visibleStudentIds(parentClaims()),
    );
    expect(after).toEqual({ kind: 'restricted', studentIds: [studentId] });
  });

  it('defaults can_collect to true and records the link in the audit log', async () => {
    const rows = await asSuperAdmin(async () =>
      tenantContextService.getManager().query(
        `SELECT g.can_collect, g.is_primary, a.action, a.actor_user_id
           FROM transport.student_guardians g
           JOIN audit.audit_logs a ON a.entity_id = g.id
          WHERE g.student_id = $1 AND g.guardian_user_id = $2`,
        [studentId, parentId],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      can_collect: true,
      is_primary: true,
      action: 'guardian.linked',
      actor_user_id: adminId,
    });
  });

  it('rejects a second link between the same student and guardian', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.link(adminClaims(), studentId, {
          guardianUserId: parentId,
          relationship: 'father',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a guardian whose role is not parent', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.link(adminClaims(), studentId, {
          guardianUserId: driverId,
          relationship: 'guardian',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a link to a student that does not exist', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.link(adminClaims(), randomUUID(), {
          guardianUserId: parentId,
          relationship: 'mother',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes the parent visibility again on unlink, and audits it', async () => {
    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.unlink(adminClaims(), studentId, parentId),
    );

    const scope = await tenantContextService.runWithTenant(parentClaims(), () =>
      abacScopeService.visibleStudentIds(parentClaims()),
    );
    expect(scope).toEqual({ kind: 'restricted', studentIds: [] });

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE action = 'guardian.unlinked' AND school_id = $1`, [
          schoolId,
        ]),
    );
    expect(rows).toHaveLength(1);
  });

  it('raises NotFound when unlinking a guardian that was never linked', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.unlink(adminClaims(), studentId, parentId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- guardians.service`
Expected: FAIL — `Cannot find module './guardians.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/students/dto/link-guardian.dto.ts`:
```ts
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { GuardianRelationship } from '../../../entities/student-guardian.entity';

const RELATIONSHIPS: GuardianRelationship[] = [
  'mother',
  'father',
  'grandparent',
  'guardian',
  'other',
];

export class LinkGuardianDto {
  @IsUUID()
  guardianUserId: string;

  @IsIn(RELATIONSHIPS)
  relationship: GuardianRelationship;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsBoolean()
  canCollect?: boolean;
}
```

`apps/api/src/transport/students/dto/guardian-response.dto.ts`:
```ts
import { GuardianRelationship, StudentGuardian } from '../../../entities/student-guardian.entity';

// No name, email or phone. The guardian's contact details live on core.users
// and are never joined into a transport response — spec §3 forbids exposing
// them to drivers and attendants, and the safest way to honour that is for the
// shape to have nowhere to put them.
export interface GuardianResponseDto {
  id: string;
  studentId: string;
  guardianUserId: string;
  relationship: GuardianRelationship;
  isPrimary: boolean;
  canCollect: boolean;
}

export function toGuardianResponse(link: StudentGuardian): GuardianResponseDto {
  return {
    id: link.id,
    studentId: link.studentId,
    guardianUserId: link.guardianUserId,
    relationship: link.relationship,
    isPrimary: link.isPrimary,
    canCollect: link.canCollect,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/students/guardians.service.ts`:
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { Student } from '../../entities/student.entity';
import { StudentGuardian } from '../../entities/student-guardian.entity';
import { User } from '../../entities/user.entity';
import { LinkGuardianDto } from './dto/link-guardian.dto';
import { asConflict, requireSchoolId } from './students.service';

@Injectable()
export class GuardiansService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  async link(
    claims: AccessTokenClaims,
    studentId: string,
    dto: LinkGuardianDto,
  ): Promise<StudentGuardian> {
    const schoolId = requireSchoolId(claims);
    const manager = this.tenantContextService.getManager();

    const student = await manager.getRepository(Student).findOne({ where: { id: studentId } });
    if (!student) {
      throw new NotFoundException('Student not found');
    }

    // A foreign key to core.users cannot express "must have role parent", so
    // the check lives here (spec §6). RLS has already restricted this lookup to
    // the caller's school, so a guardian from another tenant reads as absent.
    const guardian = await manager
      .getRepository(User)
      .findOne({ where: { id: dto.guardianUserId } });
    if (!guardian) {
      throw new BadRequestException('Guardian user not found in this school');
    }
    if (guardian.role !== 'parent') {
      throw new BadRequestException(
        `Guardian must be a user with role 'parent', but this user has role '${guardian.role}'`,
      );
    }

    let link: StudentGuardian;
    try {
      link = await manager.getRepository(StudentGuardian).save({
        schoolId,
        studentId,
        guardianUserId: dto.guardianUserId,
        relationship: dto.relationship,
        isPrimary: dto.isPrimary ?? false,
        canCollect: dto.canCollect ?? true,
      });
    } catch (error) {
      throw asConflict(error, 'That guardian is already linked to this student');
    }

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'guardian.linked',
      entityType: 'student_guardian',
      entityId: link.id,
      metadata: { studentId, guardianUserId: dto.guardianUserId },
    });

    return link;
  }

  async unlink(
    claims: AccessTokenClaims,
    studentId: string,
    guardianUserId: string,
  ): Promise<void> {
    const schoolId = requireSchoolId(claims);
    const repository = this.tenantContextService
      .getManager()
      .getRepository(StudentGuardian);

    const link = await repository.findOne({ where: { studentId, guardianUserId } });
    if (!link) {
      throw new NotFoundException('That guardian is not linked to this student');
    }

    // The audit row is written before the delete so it captures the link's id
    // while the row still exists; both statements share the request
    // transaction, so a failure in either leaves neither behind.
    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'guardian.unlinked',
      entityType: 'student_guardian',
      entityId: link.id,
      metadata: { studentId, guardianUserId },
    });

    await repository.delete({ id: link.id });
  }
}
```

Unlinking is a genuine row delete, unlike students and assignments. The global constraint on soft deletion exists because assignment and enrolment history is read later by fee calculation and by operators reconstructing events; a revoked guardian link has no such downstream reader, and the audit row records that it happened.

- [ ] **Step 5: Wire the endpoints into the controller**

Add to `students.controller.ts` — the constructor gains `private readonly guardiansService: GuardiansService`, and:

```ts
  @Roles('school_admin')
  @Post(':id/guardians')
  async linkGuardian(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkGuardianDto,
  ): Promise<GuardianResponseDto> {
    return toGuardianResponse(await this.guardiansService.link(user, id, dto));
  }

  @Roles('school_admin')
  @HttpCode(204)
  @Delete(':id/guardians/:guardianUserId')
  async unlinkGuardian(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('guardianUserId', ParseUUIDPipe) guardianUserId: string,
  ): Promise<void> {
    await this.guardiansService.unlink(user, id, guardianUserId);
  }
```

Import `Delete` and `HttpCode` from `@nestjs/common`, plus `GuardiansService`, `LinkGuardianDto`, `GuardianResponseDto` and `toGuardianResponse`. The spec writes this path as `DELETE /students/:id/guardians`; the guardian's id has to appear somewhere, and a path segment is the conventional place for it.

Then add `GuardiansService` to the `providers` array in `students.module.ts`.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- guardians.service`
Expected: PASS, 7 tests. Then the full suite twice, green both times.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transport/students/
git commit -m "feat: add guardian links granting parents scoped access to their children"
```

---

### Task 10: Vehicles

**Files:**
- Create: `apps/api/src/transport/vehicles/vehicles.service.ts`
- Create: `apps/api/src/transport/vehicles/vehicles.controller.ts`
- Create: `apps/api/src/transport/vehicles/vehicles.module.ts`
- Create: `apps/api/src/transport/vehicles/dto/create-vehicle.dto.ts`
- Create: `apps/api/src/transport/vehicles/dto/update-vehicle.dto.ts`
- Create: `apps/api/src/transport/vehicles/dto/vehicle-response.dto.ts`
- Test: `apps/api/src/transport/vehicles/vehicles.service.spec.ts`

**Interfaces:**
- Consumes: `Vehicle`, `VehicleOwnership`, `VehicleStatus` (Task 3); `requireSchoolId` and `asConflict` from `../students/students.service` (Task 7); `TenantContextService`, `AuditService`, `PaginationQueryDto`.
- Produces: `VehiclesService` with `create(claims, dto)`, `findAll(claims, limit, offset)`, `findById(claims, id)`, `update(claims, id, dto)`; `VehicleResponseDto` + `toVehicleResponse`; `VehiclesModule`.

No ABAC here. A vehicle is not personal data and carries no per-person scope — every `school_admin` in a school sees the whole fleet, and RLS keeps other schools out. Routes (Task 12) reference vehicles, and drivers see their route's default vehicle through the route response rather than through this module.

The one domain rule worth enforcing: `ownership_type` other than `school_owned` requires `operator_name`. Spec §2 records that Kerala school transport is genuinely mixed, and a contracted bus with no named operator is an unusable record — there is nobody to call when it does not arrive.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/vehicles/vehicles.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { VehiclesService } from './vehicles.service';

describe('VehiclesService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: VehiclesService;

  let schoolId: string;
  let adminId: string;
  let vehicleId: string;

  const registrationNumber = `KL-07-${randomUUID().slice(0, 4).toUpperCase()}`;

  const adminClaims = (): AccessTokenClaims => ({
    sub: adminId,
    schoolId,
    role: 'school_admin',
    isSuperAdmin: false,
  });

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new VehiclesService(tenantContextService, new AuditService(tenantContextService));

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Vehicles School') RETURNING id`,
      );
      schoolId = school.id;
      const [admin] = await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'school_admin', $2, 'x', 'Admin') RETURNING id`,
        [schoolId, `vehicles-admin-${randomUUID()}@example.com`],
      );
      adminId = admin.id;
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('creates a school-owned vehicle and audits it', async () => {
    const vehicle = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), {
        registrationNumber,
        capacity: 42,
        ownershipType: 'school_owned',
      }),
    );

    expect(vehicle.status).toBe('active');
    expect(vehicle.operatorName).toBeNull();
    vehicleId = vehicle.id;

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action, entity_type FROM audit.audit_logs WHERE entity_id = $1`, [vehicle.id]),
    );
    expect(rows).toEqual([{ action: 'vehicle.created', entity_type: 'vehicle' }]);
  });

  it('requires an operator name for a vehicle that is not school-owned', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), {
          registrationNumber: `KL-07-${randomUUID().slice(0, 4).toUpperCase()}`,
          capacity: 30,
          ownershipType: 'contracted',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a contracted vehicle when the operator is named', async () => {
    const vehicle = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), {
        registrationNumber: `KL-07-${randomUUID().slice(0, 4).toUpperCase()}`,
        capacity: 30,
        ownershipType: 'contracted',
        operatorName: 'Nair Travels',
      }),
    );

    expect(vehicle.operatorName).toBe('Nair Travels');
  });

  it('rejects a duplicate registration number within the school', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), {
          registrationNumber,
          capacity: 20,
          ownershipType: 'school_owned',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates a vehicle and audits the update', async () => {
    const updated = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.update(adminClaims(), vehicleId, { status: 'maintenance', capacity: 40 }),
    );

    expect(updated.status).toBe('maintenance');
    expect(updated.capacity).toBe(40);

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
          vehicleId,
        ]),
    );
    expect(rows.map((row: { action: string }) => row.action)).toEqual([
      'vehicle.created',
      'vehicle.updated',
    ]);
  });

  it('keeps the operator-name rule on update', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.update(adminClaims(), vehicleId, { ownershipType: 'contracted' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('raises NotFound for an unknown vehicle', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.findById(adminClaims(), randomUUID()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

The "keeps the operator-name rule on update" case is the one that is easy to get wrong. A `PATCH` that changes only `ownershipType` has to be validated against the **merged** record, not against the patch — validating the patch alone would let a school-owned bus become contracted with no operator, which is exactly the state the create-time rule exists to prevent.

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- vehicles.service`
Expected: FAIL — `Cannot find module './vehicles.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/vehicles/dto/create-vehicle.dto.ts`:
```ts
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleOwnership } from '../../../entities/vehicle.entity';

const OWNERSHIP_TYPES: VehicleOwnership[] = ['school_owned', 'contracted', 'other'];

export class CreateVehicleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  registrationNumber: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  capacity: number;

  @IsIn(OWNERSHIP_TYPES)
  ownershipType: VehicleOwnership;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  operatorName?: string;
}
```

`apps/api/src/transport/vehicles/dto/update-vehicle.dto.ts`:
```ts
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleOwnership, VehicleStatus } from '../../../entities/vehicle.entity';

const OWNERSHIP_TYPES: VehicleOwnership[] = ['school_owned', 'contracted', 'other'];
const STATUSES: VehicleStatus[] = ['active', 'maintenance', 'retired'];

export class UpdateVehicleDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  capacity?: number;

  @IsOptional()
  @IsIn(OWNERSHIP_TYPES)
  ownershipType?: VehicleOwnership;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  operatorName?: string | null;

  @IsOptional()
  @IsIn(STATUSES)
  status?: VehicleStatus;
}
```

`registrationNumber` is not updatable, on the same reasoning as `admissionNumber`: it identifies a physical vehicle against documents this system does not own.

`apps/api/src/transport/vehicles/dto/vehicle-response.dto.ts`:
```ts
import { Vehicle, VehicleOwnership, VehicleStatus } from '../../../entities/vehicle.entity';

export interface VehicleResponseDto {
  id: string;
  registrationNumber: string;
  capacity: number;
  ownershipType: VehicleOwnership;
  operatorName: string | null;
  status: VehicleStatus;
}

export function toVehicleResponse(vehicle: Vehicle): VehicleResponseDto {
  return {
    id: vehicle.id,
    registrationNumber: vehicle.registrationNumber,
    capacity: vehicle.capacity,
    ownershipType: vehicle.ownershipType,
    operatorName: vehicle.operatorName,
    status: vehicle.status,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/vehicles/vehicles.service.ts`:
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { Vehicle, VehicleOwnership } from '../../entities/vehicle.entity';
import { Page, asConflict, requireSchoolId } from '../students/students.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

/**
 * A contracted or otherwise non-school vehicle must name its operator: when the
 * bus does not turn up, the operator is who the school calls. Checked against
 * the merged record so a PATCH cannot reach the same invalid state a POST is
 * prevented from creating.
 */
function assertOperatorNamed(ownershipType: VehicleOwnership, operatorName: string | null): void {
  if (ownershipType !== 'school_owned' && !operatorName) {
    throw new BadRequestException(
      `operatorName is required when ownershipType is '${ownershipType}'`,
    );
  }
}

@Injectable()
export class VehiclesService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  async create(claims: AccessTokenClaims, dto: CreateVehicleDto): Promise<Vehicle> {
    const schoolId = requireSchoolId(claims);
    const operatorName = dto.operatorName ?? null;
    assertOperatorNamed(dto.ownershipType, operatorName);

    const manager = this.tenantContextService.getManager();
    let vehicle: Vehicle;
    try {
      vehicle = await manager.getRepository(Vehicle).save({
        schoolId,
        registrationNumber: dto.registrationNumber,
        capacity: dto.capacity,
        ownershipType: dto.ownershipType,
        operatorName,
        status: 'active' as const,
      });
    } catch (error) {
      throw asConflict(error, 'A vehicle with that registration number already exists');
    }

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'vehicle.created',
      entityType: 'vehicle',
      entityId: vehicle.id,
    });

    return vehicle;
  }

  async findAll(
    _claims: AccessTokenClaims,
    limit: number,
    offset: number,
  ): Promise<Page<Vehicle>> {
    const [items, total] = await this.tenantContextService
      .getManager()
      .getRepository(Vehicle)
      .findAndCount({ take: limit, skip: offset, order: { registrationNumber: 'ASC' } });
    return { items, total };
  }

  async findById(_claims: AccessTokenClaims, id: string): Promise<Vehicle> {
    const vehicle = await this.tenantContextService
      .getManager()
      .getRepository(Vehicle)
      .findOne({ where: { id } });
    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }
    return vehicle;
  }

  async update(
    claims: AccessTokenClaims,
    id: string,
    dto: UpdateVehicleDto,
  ): Promise<Vehicle> {
    const schoolId = requireSchoolId(claims);
    const repository = this.tenantContextService.getManager().getRepository(Vehicle);

    const existing = await repository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Vehicle not found');
    }

    const patch: Partial<Vehicle> = {};
    if (dto.capacity !== undefined) patch.capacity = dto.capacity;
    if (dto.ownershipType !== undefined) patch.ownershipType = dto.ownershipType;
    if (dto.operatorName !== undefined) patch.operatorName = dto.operatorName;
    if (dto.status !== undefined) patch.status = dto.status;

    const merged = { ...existing, ...patch };
    assertOperatorNamed(merged.ownershipType, merged.operatorName);

    const updated = await repository.save(merged);

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'vehicle.updated',
      entityType: 'vehicle',
      entityId: updated.id,
    });

    return updated;
  }
}
```

`findAll` and `findById` take `_claims` they do not read. The parameter stays so every service in this sub-project has the same shape and so adding a scope rule later — a contractor account that sees only its own buses, say — is a change inside the method rather than a change to every caller.

- [ ] **Step 5: Write the controller and module**

`apps/api/src/transport/vehicles/vehicles.controller.ts` follows Task 8's `StudentsController` exactly, with `@Roles('school_admin')` on all four handlers, `ParseUUIDPipe` on `:id`, `PaginationQueryDto` on the list, and `toVehicleResponse` mapping every return.

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../auth/token.service';
import { PaginatedResponse, PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehicleResponseDto, toVehicleResponse } from './dto/vehicle-response.dto';

@Controller('vehicles')
@Roles('school_admin')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Post()
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateVehicleDto,
  ): Promise<VehicleResponseDto> {
    return toVehicleResponse(await this.vehiclesService.create(user, dto));
  }

  @Get()
  async findAll(
    @CurrentUser() user: AccessTokenClaims,
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<VehicleResponseDto>> {
    const { items, total } = await this.vehiclesService.findAll(
      user,
      pagination.limit,
      pagination.offset,
    );
    return {
      items: items.map(toVehicleResponse),
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VehicleResponseDto> {
    return toVehicleResponse(await this.vehiclesService.findById(user, id));
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ): Promise<VehicleResponseDto> {
    return toVehicleResponse(await this.vehiclesService.update(user, id, dto));
  }
}
```

The class-level `@Roles('school_admin')` works because `RolesGuard` uses `getAllAndOverride` across handler and class — a handler with no decorator of its own inherits the class's.

`apps/api/src/transport/vehicles/vehicles.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuditModule } from '../../audit/audit.module';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- vehicles.service`
Expected: PASS, 7 tests. Then the full suite twice, green both times.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transport/vehicles/
git commit -m "feat: add vehicles module with ownership and operator-name rules"
```

---

### Task 11: Stops

**Files:**
- Create: `apps/api/src/transport/stops/stops.service.ts`
- Create: `apps/api/src/transport/stops/stops.controller.ts`
- Create: `apps/api/src/transport/stops/stops.module.ts`
- Create: `apps/api/src/transport/stops/dto/create-stop.dto.ts`
- Create: `apps/api/src/transport/stops/dto/update-stop.dto.ts`
- Create: `apps/api/src/transport/stops/dto/stop-response.dto.ts`
- Test: `apps/api/src/transport/stops/stops.service.spec.ts`

**Interfaces:**
- Consumes: `Stop` (Task 3); `requireSchoolId` from `../students/students.service`; `Page`; `TenantContextService`, `AuditService`.
- Produces: `StopsService` with `create`, `findAll`, `findById`, `update` on the Task 10 signatures; `StopResponseDto` + `toStopResponse`; `StopsModule`.

**The one trap in this task is the numeric columns.** `latitude` and `longitude` are `numeric(9,6)`, and the `pg` driver returns `numeric` as a **string**, not a number — it does that deliberately, because a JavaScript double cannot represent every value a Postgres `numeric` can. The entity types them `string` (Task 3) for that reason. So:

- The DTO accepts a `number` (JSON has no other sensible type for a coordinate) and the service converts with `.toFixed(6)` before writing.
- The response DTO converts back with `Number(...)`, so clients get numbers rather than strings.
- The tests assert on numbers via the response mapper, and on strings when reading the entity directly.

Getting this wrong produces `"9.981000"` in an API response where a map component expects `9.981`, and it will not be caught by types alone — hence a test that pins it.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/stops/stops.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { StopsService } from './stops.service';
import { toStopResponse } from './dto/stop-response.dto';

describe('StopsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: StopsService;

  let schoolId: string;
  let adminId: string;
  let stopId: string;

  const adminClaims = (): AccessTokenClaims => ({
    sub: adminId,
    schoolId,
    role: 'school_admin',
    isSuperAdmin: false,
  });

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new StopsService(tenantContextService, new AuditService(tenantContextService));

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Stops School') RETURNING id`,
      );
      schoolId = school.id;
      const [admin] = await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'school_admin', $2, 'x', 'Admin') RETURNING id`,
        [schoolId, `stops-admin-${randomUUID()}@example.com`],
      );
      adminId = admin.id;
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('creates a stop with the default geofence radius and audits it', async () => {
    const stop = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), {
        name: 'Edappally Junction',
        latitude: 10.024_9,
        longitude: 76.308_1,
      }),
    );

    expect(stop.geofenceRadiusM).toBe(150);
    expect(stop.specialInstructions).toBeNull();
    stopId = stop.id;

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1`, [stop.id]),
    );
    expect(rows).toEqual([{ action: 'stop.created' }]);
  });

  it('round-trips coordinates as numbers through the response DTO', async () => {
    const stop = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.findById(adminClaims(), stopId),
    );

    // The pg driver hands `numeric` back as a string; the entity reflects that.
    expect(typeof stop.latitude).toBe('string');

    const response = toStopResponse(stop);
    expect(response.latitude).toBeCloseTo(10.0249, 6);
    expect(response.longitude).toBeCloseTo(76.3081, 6);
    expect(typeof response.latitude).toBe('number');
  });

  it('updates the geofence radius and special instructions', async () => {
    const updated = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.update(adminClaims(), stopId, {
        geofenceRadiusM: 80,
        specialInstructions: 'Pick up on the far side of the flyover',
      }),
    );

    expect(updated.geofenceRadiusM).toBe(80);
    expect(updated.specialInstructions).toBe('Pick up on the far side of the flyover');

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
          stopId,
        ]),
    );
    expect(rows.map((row: { action: string }) => row.action)).toEqual([
      'stop.created',
      'stop.updated',
    ]);
  });

  it('lists stops for the school in name order', async () => {
    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), { name: 'Aluva Bypass', latitude: 10.1, longitude: 76.35 }),
    );

    const page = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.findAll(adminClaims(), 50, 0),
    );

    expect(page.total).toBe(2);
    expect(page.items.map((stop) => stop.name)).toEqual(['Aluva Bypass', 'Edappally Junction']);
  });

  it('raises NotFound for an unknown stop', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.findById(adminClaims(), randomUUID()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- stops.service`
Expected: FAIL — `Cannot find module './stops.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/stops/dto/create-stop.dto.ts`:
```ts
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStopDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @Type(() => Number)
  @IsLatitude()
  latitude: number;

  @Type(() => Number)
  @IsLongitude()
  longitude: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(2000)
  geofenceRadiusM?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  specialInstructions?: string;
}
```

The radius floor of 20 m is not arbitrary: consumer GPS is routinely 10–20 m off, so a smaller geofence would never trigger reliably. Sub-project 3 owns the detection logic; this bound keeps it from being handed data it cannot work with.

`apps/api/src/transport/stops/dto/update-stop.dto.ts` mirrors the create DTO with every field optional and `latitude`/`longitude` included — a stop genuinely does get moved to the other side of a junction.

```ts
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateStopDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(2000)
  geofenceRadiusM?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  specialInstructions?: string | null;
}
```

`apps/api/src/transport/stops/dto/stop-response.dto.ts`:
```ts
import { Stop } from '../../../entities/stop.entity';

export interface StopResponseDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
  specialInstructions: string | null;
}

// `numeric` arrives from the driver as a string. Converting here — rather than
// leaving it to each caller — is what keeps a coordinate from reaching a map
// component as "10.024900".
export function toStopResponse(stop: Stop): StopResponseDto {
  return {
    id: stop.id,
    name: stop.name,
    latitude: Number(stop.latitude),
    longitude: Number(stop.longitude),
    geofenceRadiusM: stop.geofenceRadiusM,
    specialInstructions: stop.specialInstructions,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/stops/stops.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { Stop } from '../../entities/stop.entity';
import { Page, requireSchoolId } from '../students/students.service';
import { CreateStopDto } from './dto/create-stop.dto';
import { UpdateStopDto } from './dto/update-stop.dto';

/** Matches the column's `numeric(9,6)` scale exactly, so no value is rounded on write. */
const COORDINATE_SCALE = 6;
const toCoordinate = (value: number): string => value.toFixed(COORDINATE_SCALE);

const DEFAULT_GEOFENCE_RADIUS_M = 150;

@Injectable()
export class StopsService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  async create(claims: AccessTokenClaims, dto: CreateStopDto): Promise<Stop> {
    const schoolId = requireSchoolId(claims);

    const stop = await this.tenantContextService
      .getManager()
      .getRepository(Stop)
      .save({
        schoolId,
        name: dto.name,
        latitude: toCoordinate(dto.latitude),
        longitude: toCoordinate(dto.longitude),
        geofenceRadiusM: dto.geofenceRadiusM ?? DEFAULT_GEOFENCE_RADIUS_M,
        specialInstructions: dto.specialInstructions ?? null,
      });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'stop.created',
      entityType: 'stop',
      entityId: stop.id,
    });

    return stop;
  }

  async findAll(_claims: AccessTokenClaims, limit: number, offset: number): Promise<Page<Stop>> {
    const [items, total] = await this.tenantContextService
      .getManager()
      .getRepository(Stop)
      .findAndCount({ take: limit, skip: offset, order: { name: 'ASC' } });
    return { items, total };
  }

  async findById(_claims: AccessTokenClaims, id: string): Promise<Stop> {
    const stop = await this.tenantContextService
      .getManager()
      .getRepository(Stop)
      .findOne({ where: { id } });
    if (!stop) {
      throw new NotFoundException('Stop not found');
    }
    return stop;
  }

  async update(claims: AccessTokenClaims, id: string, dto: UpdateStopDto): Promise<Stop> {
    const schoolId = requireSchoolId(claims);
    const repository = this.tenantContextService.getManager().getRepository(Stop);

    const existing = await repository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Stop not found');
    }

    const patch: Partial<Stop> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.latitude !== undefined) patch.latitude = toCoordinate(dto.latitude);
    if (dto.longitude !== undefined) patch.longitude = toCoordinate(dto.longitude);
    if (dto.geofenceRadiusM !== undefined) patch.geofenceRadiusM = dto.geofenceRadiusM;
    if (dto.specialInstructions !== undefined) {
      patch.specialInstructions = dto.specialInstructions;
    }

    const updated = await repository.save({ ...existing, ...patch });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'stop.updated',
      entityType: 'stop',
      entityId: updated.id,
    });

    return updated;
  }
}
```

- [ ] **Step 5: Write the controller and module**

`apps/api/src/transport/stops/stops.controller.ts` is Task 10's `VehiclesController` with `@Controller('stops')`, `@Roles('school_admin')` at class level, `StopsService`, the stop DTOs and `toStopResponse`. Four handlers: `POST /stops`, `GET /stops`, `GET /stops/:id`, `PATCH /stops/:id`.

`apps/api/src/transport/stops/stops.module.ts` is Task 10's `VehiclesModule` with `StopsController`/`StopsService` substituted, importing `AuthModule` and `AuditModule` and exporting `StopsService` (Task 13 consumes it to validate that a stop exists before putting it on a route).

- [ ] **Step 6: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- stops.service`
Expected: PASS, 5 tests. Then the full suite twice, green both times.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transport/stops/
git commit -m "feat: add stops module with coordinate and geofence handling"
```

---

### Task 12: Routes

**Files:**
- Create: `apps/api/src/transport/routes/routes.service.ts`
- Create: `apps/api/src/transport/routes/routes.controller.ts`
- Create: `apps/api/src/transport/routes/routes.module.ts`
- Create: `apps/api/src/transport/routes/dto/create-route.dto.ts`
- Create: `apps/api/src/transport/routes/dto/update-route.dto.ts`
- Create: `apps/api/src/transport/routes/dto/route-response.dto.ts`
- Test: `apps/api/src/transport/routes/routes.service.spec.ts`

**Interfaces:**
- Consumes: `Route`, `RouteStatus` (Task 4); `Vehicle` (Task 3); `User`, `UserRole`; `requireSchoolId`, `Page` from `../students/students.service`; `TenantContextService`, `AuditService`.
- Produces: `RoutesService` with `create(claims, dto)`, `findAll(claims, limit, offset)`, `findById(claims, id)`, `update(claims, id, dto)`; `RouteResponseDto` + `toRouteResponse`; `RoutesModule` exporting `RoutesService`.

**Two rules this task owns.**

First, the *role of a referenced user is checked in the service*. `default_driver_user_id` has a foreign key to `core.users`, and a foreign key cannot say "must have role `driver`" (spec §6). Without the check, a school_admin could be set as a route's driver and would then be handed every student on it by `AbacScopeService`'s driver branch — a quiet widening of access through a data-entry mistake.

Second, *a driver lists only their own routes*. This is the routes-side counterpart to student scoping, and it gets a test that fails if the filter is removed.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/routes/routes.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { RoutesService } from './routes.service';

describe('RoutesService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: RoutesService;

  let schoolId: string;
  let adminId: string;
  let driverId: string;
  let otherDriverId: string;
  let attendantId: string;
  let vehicleId: string;
  let routeId: string;

  const claimsFor = (role: AccessTokenClaims['role'], sub: string): AccessTokenClaims => ({
    sub,
    schoolId,
    role,
    isSuperAdmin: false,
  });
  const adminClaims = (): AccessTokenClaims => claimsFor('school_admin', adminId);

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new RoutesService(tenantContextService, new AuditService(tenantContextService));

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Routes School') RETURNING id`,
      );
      schoolId = school.id;

      const insertUser = async (role: string, name: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [schoolId, role, `routes-${role}-${randomUUID()}@example.com`, name],
        );
        return row.id;
      };
      adminId = await insertUser('school_admin', 'Admin');
      driverId = await insertUser('driver', 'Driver One');
      otherDriverId = await insertUser('driver', 'Driver Two');
      attendantId = await insertUser('attendant', 'Attendant');

      const [vehicle] = await manager.query(
        `INSERT INTO transport.vehicles (school_id, registration_number, capacity, ownership_type, status)
         VALUES ($1, $2, 40, 'school_owned', 'active') RETURNING id`,
        [schoolId, `KL-01-${randomUUID().slice(0, 4).toUpperCase()}`],
      );
      vehicleId = vehicle.id;
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('creates a route with its defaults and audits it', async () => {
    const route = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), {
        name: 'Route 12',
        description: 'Edappally loop',
        defaultVehicleId: vehicleId,
        defaultDriverUserId: driverId,
        defaultAttendantUserId: attendantId,
      }),
    );

    expect(route.status).toBe('active');
    expect(route.defaultDriverUserId).toBe(driverId);
    routeId = route.id;

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1`, [route.id]),
    );
    expect(rows).toEqual([{ action: 'route.created' }]);
  });

  it('rejects a default driver whose role is not driver', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), { name: 'Route 13', defaultDriverUserId: attendantId }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a default attendant whose role is not attendant', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), { name: 'Route 14', defaultAttendantUserId: driverId }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a default vehicle that does not exist in this school', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), { name: 'Route 15', defaultVehicleId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shows a school_admin every route in the school', async () => {
    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), { name: 'Route 20', defaultDriverUserId: otherDriverId }),
    );

    const page = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.findAll(adminClaims(), 50, 0),
    );

    expect(page.items.map((route) => route.name)).toEqual(['Route 12', 'Route 20']);
  });

  it('shows a driver only the routes they drive', async () => {
    const page = await tenantContextService.runWithTenant(claimsFor('driver', driverId), () =>
      service.findAll(claimsFor('driver', driverId), 50, 0),
    );

    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(routeId);
  });

  it('refuses a driver reading a route they do not drive', async () => {
    const otherRoute = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.findAll(adminClaims(), 50, 0),
    );
    const notMine = otherRoute.items.find((route) => route.id !== routeId);

    await expect(
      tenantContextService.runWithTenant(claimsFor('driver', driverId), () =>
        service.findById(claimsFor('driver', driverId), notMine!.id),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates a route and audits the update', async () => {
    const updated = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.update(adminClaims(), routeId, { status: 'inactive', defaultDriverUserId: null }),
    );

    expect(updated.status).toBe('inactive');
    expect(updated.defaultDriverUserId).toBeNull();

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
          routeId,
        ]),
    );
    expect(rows.map((row: { action: string }) => row.action)).toEqual([
      'route.created',
      'route.updated',
    ]);
  });
});
```

"Refuses a driver reading a route they do not drive" expects **404, not 403**. A driver has no business knowing which route ids exist outside their own work; returning 403 would confirm the id is real. Task 7's students used 403 because there the caller's *role* legitimately grants student access and only the specific row is out of scope. Here the row is simply not part of the caller's world.

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- routes.service`
Expected: FAIL — `Cannot find module './routes.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/routes/dto/create-route.dto.ts`:
```ts
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateRouteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUUID()
  defaultVehicleId?: string;

  @IsOptional()
  @IsUUID()
  defaultDriverUserId?: string;

  @IsOptional()
  @IsUUID()
  defaultAttendantUserId?: string;
}
```

`apps/api/src/transport/routes/dto/update-route.dto.ts`:
```ts
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { RouteStatus } from '../../../entities/route.entity';

const STATUSES: RouteStatus[] = ['active', 'inactive'];

// The three default_* fields are explicitly nullable: clearing a route's driver
// when they leave the school is an ordinary operation, and `ValidateIf` lets
// `null` through while still rejecting a malformed string.
export class UpdateRouteDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  defaultVehicleId?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  defaultDriverUserId?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  defaultAttendantUserId?: string | null;

  @IsOptional()
  @IsIn(STATUSES)
  status?: RouteStatus;
}
```

`apps/api/src/transport/routes/dto/route-response.dto.ts`:
```ts
import { Route, RouteStatus } from '../../../entities/route.entity';

export interface RouteResponseDto {
  id: string;
  name: string;
  description: string | null;
  defaultVehicleId: string | null;
  defaultDriverUserId: string | null;
  defaultAttendantUserId: string | null;
  status: RouteStatus;
}

export function toRouteResponse(route: Route): RouteResponseDto {
  return {
    id: route.id,
    name: route.name,
    description: route.description,
    defaultVehicleId: route.defaultVehicleId,
    defaultDriverUserId: route.defaultDriverUserId,
    defaultAttendantUserId: route.defaultAttendantUserId,
    status: route.status,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/routes/routes.service.ts`:
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FindOptionsWhere } from 'typeorm';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { Route } from '../../entities/route.entity';
import { Vehicle } from '../../entities/vehicle.entity';
import { User, UserRole } from '../../entities/user.entity';
import { Page, requireSchoolId } from '../students/students.service';
import { CreateRouteDto } from './dto/create-route.dto';
import { UpdateRouteDto } from './dto/update-route.dto';

@Injectable()
export class RoutesService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * A foreign key to core.users cannot express "must have role driver", so the
   * role is checked here. This is not cosmetic validation: AbacScopeService
   * hands every student on a route to whoever sits in default_driver_user_id,
   * so a wrong role here silently widens access.
   */
  private async assertUserHasRole(
    userId: string | null | undefined,
    role: UserRole,
    field: string,
  ): Promise<void> {
    if (!userId) {
      return;
    }
    // RLS has already narrowed this lookup to the caller's school, so a user in
    // another tenant reads as absent rather than as a role mismatch.
    const user = await this.tenantContextService
      .getManager()
      .getRepository(User)
      .findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException(`${field} does not name a user in this school`);
    }
    if (user.role !== role) {
      throw new BadRequestException(
        `${field} must name a user with role '${role}', but that user has role '${user.role}'`,
      );
    }
  }

  private async assertVehicleExists(vehicleId: string | null | undefined): Promise<void> {
    if (!vehicleId) {
      return;
    }
    const vehicle = await this.tenantContextService
      .getManager()
      .getRepository(Vehicle)
      .findOne({ where: { id: vehicleId } });
    if (!vehicle) {
      throw new BadRequestException('defaultVehicleId does not name a vehicle in this school');
    }
  }

  /**
   * Which routes a caller may see. A driver or attendant sees only routes they
   * are the default for; everyone else with route access sees the school's
   * routes, which RLS has already limited to their tenant.
   */
  private scopeFor(claims: AccessTokenClaims): FindOptionsWhere<Route> {
    if (claims.role === 'driver') {
      return { defaultDriverUserId: claims.sub };
    }
    if (claims.role === 'attendant') {
      return { defaultAttendantUserId: claims.sub };
    }
    return {};
  }

  async create(claims: AccessTokenClaims, dto: CreateRouteDto): Promise<Route> {
    const schoolId = requireSchoolId(claims);

    await this.assertVehicleExists(dto.defaultVehicleId);
    await this.assertUserHasRole(dto.defaultDriverUserId, 'driver', 'defaultDriverUserId');
    await this.assertUserHasRole(
      dto.defaultAttendantUserId,
      'attendant',
      'defaultAttendantUserId',
    );

    const route = await this.tenantContextService
      .getManager()
      .getRepository(Route)
      .save({
        schoolId,
        name: dto.name,
        description: dto.description ?? null,
        defaultVehicleId: dto.defaultVehicleId ?? null,
        defaultDriverUserId: dto.defaultDriverUserId ?? null,
        defaultAttendantUserId: dto.defaultAttendantUserId ?? null,
        status: 'active' as const,
      });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'route.created',
      entityType: 'route',
      entityId: route.id,
    });

    return route;
  }

  async findAll(claims: AccessTokenClaims, limit: number, offset: number): Promise<Page<Route>> {
    const [items, total] = await this.tenantContextService
      .getManager()
      .getRepository(Route)
      .findAndCount({
        where: this.scopeFor(claims),
        take: limit,
        skip: offset,
        order: { name: 'ASC' },
      });
    return { items, total };
  }

  /**
   * Out-of-scope routes read as NotFound rather than Forbidden: a driver has no
   * business learning which route ids exist outside their own work, and a 403
   * would confirm the id is real.
   */
  async findById(claims: AccessTokenClaims, id: string): Promise<Route> {
    const route = await this.tenantContextService
      .getManager()
      .getRepository(Route)
      .findOne({ where: { id, ...this.scopeFor(claims) } });
    if (!route) {
      throw new NotFoundException('Route not found');
    }
    return route;
  }

  async update(claims: AccessTokenClaims, id: string, dto: UpdateRouteDto): Promise<Route> {
    const schoolId = requireSchoolId(claims);
    const repository = this.tenantContextService.getManager().getRepository(Route);

    const existing = await repository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Route not found');
    }

    await this.assertVehicleExists(dto.defaultVehicleId);
    await this.assertUserHasRole(dto.defaultDriverUserId, 'driver', 'defaultDriverUserId');
    await this.assertUserHasRole(
      dto.defaultAttendantUserId,
      'attendant',
      'defaultAttendantUserId',
    );

    const patch: Partial<Route> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.defaultVehicleId !== undefined) patch.defaultVehicleId = dto.defaultVehicleId;
    if (dto.defaultDriverUserId !== undefined) {
      patch.defaultDriverUserId = dto.defaultDriverUserId;
    }
    if (dto.defaultAttendantUserId !== undefined) {
      patch.defaultAttendantUserId = dto.defaultAttendantUserId;
    }
    if (dto.status !== undefined) patch.status = dto.status;

    const updated = await repository.save({ ...existing, ...patch });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'route.updated',
      entityType: 'route',
      entityId: updated.id,
    });

    return updated;
  }
}
```

`assertUserHasRole` and `assertVehicleExists` both return early on a null or absent value, so clearing a default (`defaultDriverUserId: null`) is allowed while setting a bad one is not.

- [ ] **Step 5: Write the controller and module**

`apps/api/src/transport/routes/routes.controller.ts` follows Task 10's shape, with per-handler roles rather than a class-level decorator, because reads and writes differ:

```ts
  @Roles('school_admin')
  @Post()                                    // create
  @Roles('school_admin', 'driver', 'attendant')
  @Get()                                     // findAll — scoped in the service
  @Roles('school_admin', 'driver', 'attendant')
  @Get(':id')                                // findOne — scoped in the service
  @Roles('school_admin')
  @Patch(':id')                              // update
```

Handler bodies mirror `VehiclesController` exactly, substituting `RoutesService`, the route DTOs and `toRouteResponse`, with `ParseUUIDPipe` on `:id`.

`apps/api/src/transport/routes/routes.module.ts` imports `AuthModule` and `AuditModule`, declares `RoutesController`, provides `RoutesService`, and exports `RoutesService` — Task 14 consumes it.

- [ ] **Step 6: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- routes.service`
Expected: PASS, 8 tests.

- [ ] **Step 7: Prove the driver scoping bites**

Temporarily make `scopeFor` return `{}` for every role, and re-run. "Shows a driver only the routes they drive" and "refuses a driver reading a route they do not drive" must both **fail**. Restore, confirm they pass, and record both outputs.

- [ ] **Step 8: Run the full suite and commit**

```bash
git add apps/api/src/transport/routes/
git commit -m "feat: add routes module with role-checked defaults and driver scoping"
```

---

### Task 13: `PUT /routes/:id/stops` — atomic stop replacement

**Files:**
- Create: `apps/api/src/transport/routes/route-stops.service.ts`
- Create: `apps/api/src/transport/routes/dto/replace-route-stops.dto.ts`
- Create: `apps/api/src/transport/routes/dto/route-stop-response.dto.ts`
- Modify: `apps/api/src/transport/routes/routes.controller.ts` — add `PUT /routes/:id/stops` and `GET /routes/:id/stops`
- Modify: `apps/api/src/transport/routes/routes.module.ts` — provide and export `RouteStopsService`
- Test: `apps/api/src/transport/routes/route-stops.service.spec.ts`

**Interfaces:**
- Consumes: `RouteStop` (Task 4), `Stop` (Task 3), `Route` (Task 4); `RoutesService.findById` for the route-scope check; `requireSchoolId`; `TenantContextService`, `AuditService`.
- Produces: `RouteStopsService` with `replace(claims, routeId, dto): Promise<RouteStop[]>` and `list(claims, routeId): Promise<RouteStop[]>`; `ReplaceRouteStopsDto` and its nested `RouteStopItemDto`; `RouteStopResponseDto` + `toRouteStopResponse`.

**Why replacement rather than per-row editing.** `route_stops` carries UNIQUE `(route_id, sequence)` and UNIQUE `(route_id, stop_id)`. Reordering two stops through individual updates transiently violates the first constraint no matter which order the updates run in, and a client-driven sequence of insert/update/delete calls cannot be made atomic across HTTP requests. A half-applied reorder leaves a route with duplicate or missing positions — a route that no longer describes a real journey. So the whole ordered set is replaced in one statement pair inside one transaction: delete all, insert all.

The transaction is the one the `TenancyInterceptor` already opened for the request. **Do not open a nested transaction or reach for the `DataSource`** — `getManager()` returns the request's transactional manager, and everything issued through it is already atomic with the audit write.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/routes/route-stops.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { RoutesService } from './routes.service';
import { RouteStopsService } from './route-stops.service';

describe('RouteStopsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: RouteStopsService;

  let schoolId: string;
  let adminId: string;
  let routeId: string;
  let otherRouteId: string;
  let stopA: string;
  let stopB: string;
  let stopC: string;

  const adminClaims = (): AccessTokenClaims => ({
    sub: adminId,
    schoolId,
    role: 'school_admin',
    isSuperAdmin: false,
  });

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  const sequences = async (route: string): Promise<{ stop_id: string; sequence: number }[]> =>
    asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(
          `SELECT stop_id, sequence FROM transport.route_stops WHERE route_id = $1 ORDER BY sequence`,
          [route],
        ),
    );

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    const auditService = new AuditService(tenantContextService);
    service = new RouteStopsService(
      tenantContextService,
      auditService,
      new RoutesService(tenantContextService, auditService),
    );

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Route Stops School') RETURNING id`,
      );
      schoolId = school.id;

      const [admin] = await manager.query(
        `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
         VALUES ($1, 'school_admin', $2, 'x', 'Admin') RETURNING id`,
        [schoolId, `route-stops-admin-${randomUUID()}@example.com`],
      );
      adminId = admin.id;

      const insertRoute = async (name: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO transport.routes (school_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
          [schoolId, name],
        );
        return row.id;
      };
      routeId = await insertRoute('Route A');
      otherRouteId = await insertRoute('Route B');

      const insertStop = async (name: string, lat: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO transport.stops (school_id, name, latitude, longitude, geofence_radius_m)
           VALUES ($1, $2, $3, '76.300000', 150) RETURNING id`,
          [schoolId, name, lat],
        );
        return row.id;
      };
      stopA = await insertStop('Stop A', '10.010000');
      stopB = await insertStop('Stop B', '10.020000');
      stopC = await insertStop('Stop C', '10.030000');
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('writes the ordered set and audits the replacement once', async () => {
    const result = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.replace(adminClaims(), routeId, {
        stops: [
          { stopId: stopA, expectedOffsetMinutes: 0 },
          { stopId: stopB, expectedOffsetMinutes: 12 },
        ],
      }),
    );

    expect(result.map((row) => row.sequence)).toEqual([1, 2]);
    expect(await sequences(routeId)).toEqual([
      { stop_id: stopA, sequence: 1 },
      { stop_id: stopB, sequence: 2 },
    ]);

    const audits = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action, entity_id FROM audit.audit_logs WHERE entity_id = $1`, [routeId]),
    );
    expect(audits).toEqual([{ action: 'route.stops_replaced', entity_id: routeId }]);
  });

  it('reverses an order that would collide if applied row by row', async () => {
    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.replace(adminClaims(), routeId, {
        stops: [
          { stopId: stopB, expectedOffsetMinutes: 0 },
          { stopId: stopA, expectedOffsetMinutes: 15 },
        ],
      }),
    );

    expect(await sequences(routeId)).toEqual([
      { stop_id: stopB, sequence: 1 },
      { stop_id: stopA, sequence: 2 },
    ]);
  });

  it('leaves the existing sequence intact when the replacement fails partway', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.replace(adminClaims(), routeId, {
          stops: [
            { stopId: stopC, expectedOffsetMinutes: 0 },
            { stopId: randomUUID(), expectedOffsetMinutes: 10 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The valid first entry must not have survived the rejected call.
    expect(await sequences(routeId)).toEqual([
      { stop_id: stopB, sequence: 1 },
      { stop_id: stopA, sequence: 2 },
    ]);
  });

  it('rejects a repeated stop within one replacement', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.replace(adminClaims(), routeId, {
          stops: [
            { stopId: stopA, expectedOffsetMinutes: 0 },
            { stopId: stopA, expectedOffsetMinutes: 10 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects offsets that do not increase along the route', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.replace(adminClaims(), routeId, {
          stops: [
            { stopId: stopA, expectedOffsetMinutes: 20 },
            { stopId: stopB, expectedOffsetMinutes: 5 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts an empty list, clearing the route', async () => {
    const result = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.replace(adminClaims(), routeId, { stops: [] }),
    );

    expect(result).toEqual([]);
    expect(await sequences(routeId)).toEqual([]);
  });

  it('does not touch another route', async () => {
    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.replace(adminClaims(), otherRouteId, {
        stops: [{ stopId: stopC, expectedOffsetMinutes: 0 }],
      }),
    );
    await tenantContextService.runWithTenant(adminClaims(), () =>
      service.replace(adminClaims(), routeId, {
        stops: [{ stopId: stopA, expectedOffsetMinutes: 0 }],
      }),
    );

    expect(await sequences(otherRouteId)).toEqual([{ stop_id: stopC, sequence: 1 }]);
  });

  it('raises NotFound for a route that does not exist', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.replace(adminClaims(), randomUUID(), { stops: [] }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

The third test is the atomicity proof, and it only proves anything because the invalid stop is **second**. A validation pass that ran before any write would pass this test trivially; the test is written so that a naive implementation which validates and inserts per row would leave `stopC` at sequence 1 and fail the assertion. Implement the validation loop first and the write second — but keep this test, because it is what stops a later refactor from interleaving them.

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- route-stops.service`
Expected: FAIL — `Cannot find module './route-stops.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/routes/dto/replace-route-stops.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsUUID, Max, Min, ValidateNested } from 'class-validator';

export class RouteStopItemDto {
  @IsUUID()
  stopId: string;

  // Minutes from the start of the route. Zero is valid — the first stop is
  // usually the route's origin.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  expectedOffsetMinutes: number;
}

export class ReplaceRouteStopsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RouteStopItemDto)
  stops: RouteStopItemDto[];
}
```

`@Type(() => RouteStopItemDto)` is required, not decorative: without it `class-transformer` leaves the array as plain objects and `@ValidateNested` silently validates nothing. That is the same class of failure as a test that cannot fail, and it is why the DTO-level rules here are backed by service-level checks that the tests exercise directly.

The sequence numbers are **not** in the DTO. They are the array's index plus one. Accepting client-supplied sequences would invite gaps and duplicates that the unique constraint would then reject with a database error rather than a clear message.

`apps/api/src/transport/routes/dto/route-stop-response.dto.ts`:
```ts
import { RouteStop } from '../../../entities/route-stop.entity';

export interface RouteStopResponseDto {
  id: string;
  routeId: string;
  stopId: string;
  sequence: number;
  expectedOffsetMinutes: number;
}

export function toRouteStopResponse(routeStop: RouteStop): RouteStopResponseDto {
  return {
    id: routeStop.id,
    routeId: routeStop.routeId,
    stopId: routeStop.stopId,
    sequence: routeStop.sequence,
    expectedOffsetMinutes: routeStop.expectedOffsetMinutes,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/routes/route-stops.service.ts`:
```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { RouteStop } from '../../entities/route-stop.entity';
import { Stop } from '../../entities/stop.entity';
import { requireSchoolId } from '../students/students.service';
import { RoutesService } from './routes.service';
import { ReplaceRouteStopsDto } from './dto/replace-route-stops.dto';

@Injectable()
export class RouteStopsService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
    private readonly routesService: RoutesService,
  ) {}

  async list(claims: AccessTokenClaims, routeId: string): Promise<RouteStop[]> {
    // Raises NotFound for a route outside the caller's scope, so a driver
    // cannot read the composition of someone else's route.
    await this.routesService.findById(claims, routeId);

    return this.tenantContextService
      .getManager()
      .getRepository(RouteStop)
      .find({ where: { routeId }, order: { sequence: 'ASC' } });
  }

  /**
   * Replaces a route's entire ordered stop list.
   *
   * Every check runs before the first write. That ordering is the whole point:
   * `route_stops` carries UNIQUE (route_id, sequence) and UNIQUE
   * (route_id, stop_id), so a per-row apply would both collide on a reorder and
   * leave a partially rewritten route behind if a later row turned out invalid.
   * Delete-all-then-insert-all inside the request transaction cannot do either.
   */
  async replace(
    claims: AccessTokenClaims,
    routeId: string,
    dto: ReplaceRouteStopsDto,
  ): Promise<RouteStop[]> {
    const schoolId = requireSchoolId(claims);
    await this.routesService.findById(claims, routeId);

    const stopIds = dto.stops.map((item) => item.stopId);

    const duplicate = stopIds.find((id, index) => stopIds.indexOf(id) !== index);
    if (duplicate) {
      throw new BadRequestException(`Stop ${duplicate} appears more than once on this route`);
    }

    for (let index = 1; index < dto.stops.length; index += 1) {
      const previous = dto.stops[index - 1];
      const current = dto.stops[index];
      if (current.expectedOffsetMinutes <= previous.expectedOffsetMinutes) {
        throw new BadRequestException(
          `expectedOffsetMinutes must increase along the route: position ${index + 1} ` +
            `(${current.expectedOffsetMinutes}) is not after position ${index} ` +
            `(${previous.expectedOffsetMinutes})`,
        );
      }
    }

    const manager = this.tenantContextService.getManager();

    if (stopIds.length > 0) {
      // RLS confines this lookup to the caller's school, so a stop belonging to
      // another tenant reads as missing rather than as a cross-tenant leak.
      const found = await manager.getRepository(Stop).find({
        where: { id: In(stopIds) },
        select: { id: true },
      });
      const foundIds = new Set(found.map((stop) => stop.id));
      const missing = stopIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `These stops do not exist in this school: ${missing.join(', ')}`,
        );
      }
    }

    const repository = manager.getRepository(RouteStop);
    await repository.delete({ routeId });

    if (dto.stops.length === 0) {
      await this.recordReplacement(schoolId, claims, routeId, 0);
      return [];
    }

    const inserted = await repository.save(
      dto.stops.map((item, index) => ({
        schoolId,
        routeId,
        stopId: item.stopId,
        sequence: index + 1,
        expectedOffsetMinutes: item.expectedOffsetMinutes,
      })),
    );

    await this.recordReplacement(schoolId, claims, routeId, inserted.length);

    return [...inserted].sort((left, right) => left.sequence - right.sequence);
  }

  private async recordReplacement(
    schoolId: string,
    claims: AccessTokenClaims,
    routeId: string,
    stopCount: number,
  ): Promise<void> {
    // One audit row for the operation, not one per stop: replacing the list is
    // a single decision by a single person, and an operator reading the log
    // wants to see that decision rather than reconstruct it from N rows.
    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'route.stops_replaced',
      entityType: 'route',
      entityId: routeId,
      metadata: { stopCount },
    });
  }
}
```

`repository.save` with an array issues a multi-row insert and returns the saved rows, but TypeORM does not guarantee their order matches the input, so the return is sorted by `sequence` explicitly rather than trusted.

- [ ] **Step 5: Wire the endpoints and the module**

Add to `routes.controller.ts` — constructor gains `private readonly routeStopsService: RouteStopsService`:

```ts
  @Roles('school_admin')
  @Put(':id/stops')
  async replaceStops(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceRouteStopsDto,
  ): Promise<RouteStopResponseDto[]> {
    const stops = await this.routeStopsService.replace(user, id, dto);
    return stops.map(toRouteStopResponse);
  }

  @Roles('school_admin', 'driver', 'attendant')
  @Get(':id/stops')
  async listStops(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RouteStopResponseDto[]> {
    const stops = await this.routeStopsService.list(user, id);
    return stops.map(toRouteStopResponse);
  }
```

Import `Put` from `@nestjs/common`, plus `RouteStopsService`, `ReplaceRouteStopsDto`, `RouteStopResponseDto` and `toRouteStopResponse`. `GET /routes/:id/stops` is not in the spec's endpoint table but is the read half of a `PUT` that would otherwise be write-only — a driver has to be able to see the stops on their route, and the scope check on `list` is the same one `findById` applies.

These two lists are deliberately not paginated. A route has tens of stops, the ordering is the payload's meaning, and paging it would let a client render half a journey.

Then add `RouteStopsService` to `providers` and `exports` in `routes.module.ts`.

- [ ] **Step 6: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- route-stops.service`
Expected: PASS, 8 tests.

- [ ] **Step 7: Prove the atomicity test bites**

Temporarily move the stop-existence check so it runs *inside* the insert loop, one row at a time, and re-run. "Leaves the existing sequence intact when the replacement fails partway" must **fail**. Restore, confirm it passes, and record both outputs.

- [ ] **Step 8: Run the full suite and commit**

```bash
git add apps/api/src/transport/routes/
git commit -m "feat: replace route stop sequences atomically in one transaction"
```

---

### Task 14: Student route assignments

**Files:**
- Create: `apps/api/src/transport/assignments/assignments.service.ts`
- Create: `apps/api/src/transport/assignments/assignments.controller.ts`
- Create: `apps/api/src/transport/assignments/assignments.module.ts`
- Create: `apps/api/src/transport/assignments/dto/create-assignment.dto.ts`
- Create: `apps/api/src/transport/assignments/dto/assignment-response.dto.ts`
- Test: `apps/api/src/transport/assignments/assignments.service.spec.ts`

**Interfaces:**
- Consumes: `StudentRouteAssignment`, `AssignmentDirection` (Task 5); `RouteStop` (Task 4); `Student` (Task 1); `AbacScopeService` (Task 6); `requireSchoolId` (Task 7); `TenantContextService`, `AuditService`.
- Produces: `AssignmentsService` with `create(claims, studentId, dto)`, `list(claims, studentId)`, `end(claims, studentId, assignmentId)`; `CreateAssignmentDto`; `AssignmentResponseDto` + `toAssignmentResponse`; `AssignmentsModule`.

**Three rules, each of which has burned a transport system somewhere.**

1. **The stop must be on the route.** A CHECK constraint cannot span tables, so this is a service-layer join against `route_stops` (spec §6). Without it a child is assigned to a stop the bus never passes, and nobody discovers it until the bus does not stop.
2. **At most one active assignment per student per direction.** Task 5 deliberately omitted a unique constraint, because a student legitimately has an ended assignment and a current one for the same route and direction — the date range distinguishes them. Uniqueness therefore has to be enforced here, where the dates can be read. "Active" means `effective_to IS NULL OR effective_to >= CURRENT_DATE`.
3. **`DELETE` end-dates, it does not delete.** It sets `effective_to = CURRENT_DATE` and returns the updated row, and the audit action is `assignment.ended`. Sub-project 6 reads this history to calculate a mid-year fee adjustment, and an operator reconstructing which bus a child rode last term needs the ended rows to still be there.

- [ ] **Step 1: Write the failing test**

`apps/api/src/transport/assignments/assignments.service.spec.ts`:
```ts
import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../../database/data-source.migration';
import { appDataSourceOptions } from '../../database/data-source';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { AbacScopeService } from '../abac/abac-scope.service';
import { AssignmentsService } from './assignments.service';

describe('AssignmentsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: AssignmentsService;

  let schoolId: string;
  let adminId: string;
  let parentId: string;
  let studentId: string;
  let otherStudentId: string;
  let routeId: string;
  let onRouteStopId: string;
  let offRouteStopId: string;
  let assignmentId: string;

  const claimsFor = (role: AccessTokenClaims['role'], sub: string): AccessTokenClaims => ({
    sub,
    schoolId,
    role,
    isSuperAdmin: false,
  });
  const adminClaims = (): AccessTokenClaims => claimsFor('school_admin', adminId);

  const asSuperAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  const today = (): string => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new AssignmentsService(
      tenantContextService,
      new AuditService(tenantContextService),
      new AbacScopeService(tenantContextService),
    );

    await asSuperAdmin(async () => {
      const manager = tenantContextService.getManager();
      const [school] = await manager.query(
        `INSERT INTO core.schools (name) VALUES ('Assignments School') RETURNING id`,
      );
      schoolId = school.id;

      const insertUser = async (role: string, name: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [schoolId, role, `assignments-${role}-${randomUUID()}@example.com`, name],
        );
        return row.id;
      };
      adminId = await insertUser('school_admin', 'Admin');
      parentId = await insertUser('parent', 'Parent');

      const insertStudent = async (name: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO transport.students (school_id, admission_number, full_name, grade, status)
           VALUES ($1, $2, $3, '4', 'active') RETURNING id`,
          [schoolId, `ADM-${randomUUID().slice(0, 8)}`, name],
        );
        return row.id;
      };
      studentId = await insertStudent('Devika Menon');
      otherStudentId = await insertStudent('Not My Child');

      const [route] = await manager.query(
        `INSERT INTO transport.routes (school_id, name, status) VALUES ($1, 'Route 7', 'active') RETURNING id`,
        [schoolId],
      );
      routeId = route.id;

      const insertStop = async (name: string, lat: string): Promise<string> => {
        const [row] = await manager.query(
          `INSERT INTO transport.stops (school_id, name, latitude, longitude, geofence_radius_m)
           VALUES ($1, $2, $3, '76.310000', 150) RETURNING id`,
          [schoolId, name, lat],
        );
        return row.id;
      };
      onRouteStopId = await insertStop('On Route', '10.040000');
      offRouteStopId = await insertStop('Off Route', '10.050000');

      await manager.query(
        `INSERT INTO transport.route_stops (school_id, route_id, stop_id, sequence, expected_offset_minutes)
         VALUES ($1, $2, $3, 1, 0)`,
        [schoolId, routeId, onRouteStopId],
      );

      await manager.query(
        `INSERT INTO transport.student_guardians (school_id, student_id, guardian_user_id, relationship, is_primary, can_collect)
         VALUES ($1, $2, $3, 'mother', true, true)`,
        [schoolId, studentId, parentId],
      );
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('assigns a student to a stop on the route and audits it', async () => {
    const assignment = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), studentId, {
        routeId,
        stopId: onRouteStopId,
        direction: 'both',
        effectiveFrom: today(),
      }),
    );

    expect(assignment.effectiveTo).toBeNull();
    expect(assignment.direction).toBe('both');
    assignmentId = assignment.id;

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action, entity_type FROM audit.audit_logs WHERE entity_id = $1`, [
          assignment.id,
        ]),
    );
    expect(rows).toEqual([
      { action: 'assignment.created', entity_type: 'student_route_assignment' },
    ]);
  });

  it('rejects a stop that is not on the route', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), otherStudentId, {
          routeId,
          stopId: offRouteStopId,
          direction: 'morning',
          effectiveFrom: today(),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a second active assignment for the same direction', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), studentId, {
          routeId,
          stopId: onRouteStopId,
          direction: 'morning',
          effectiveFrom: today(),
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects effective_to before effective_from', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.create(adminClaims(), otherStudentId, {
          routeId,
          stopId: onRouteStopId,
          direction: 'afternoon',
          effectiveFrom: '2026-09-10',
          effectiveTo: '2026-09-01',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("lets a parent list their own child's assignments", async () => {
    const rows = await tenantContextService.runWithTenant(claimsFor('parent', parentId), () =>
      service.list(claimsFor('parent', parentId), studentId),
    );

    expect(rows.map((row) => row.id)).toEqual([assignmentId]);
  });

  it("refuses a parent listing another family's child", async () => {
    await expect(
      tenantContextService.runWithTenant(claimsFor('parent', parentId), () =>
        service.list(claimsFor('parent', parentId), otherStudentId),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('end-dates an assignment instead of deleting it', async () => {
    const ended = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.end(adminClaims(), studentId, assignmentId),
    );

    expect(ended.effectiveTo).toBe(today());

    const rows = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(
          `SELECT id, effective_to FROM transport.student_route_assignments WHERE id = $1`,
          [assignmentId],
        ),
    );
    expect(rows).toHaveLength(1);

    const audits = await asSuperAdmin(async () =>
      tenantContextService
        .getManager()
        .query(`SELECT action FROM audit.audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
          assignmentId,
        ]),
    );
    expect(audits.map((row: { action: string }) => row.action)).toEqual([
      'assignment.created',
      'assignment.ended',
    ]);
  });

  it('allows a fresh assignment once the previous one has ended', async () => {
    const replacement = await tenantContextService.runWithTenant(adminClaims(), () =>
      service.create(adminClaims(), studentId, {
        routeId,
        stopId: onRouteStopId,
        direction: 'both',
        effectiveFrom: today(),
      }),
    );

    expect(replacement.id).not.toBe(assignmentId);
  });

  it('raises NotFound when ending an assignment that belongs to another student', async () => {
    await expect(
      tenantContextService.runWithTenant(adminClaims(), () =>
        service.end(adminClaims(), otherStudentId, assignmentId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

"Allows a fresh assignment once the previous one has ended" is the test that keeps rule 2 from being over-applied. An implementation that checked only `(student_id, direction)` without consulting the dates would reject this and make a mid-year route change impossible — the precise scenario the date columns exist for.

**Two different "active" predicates, and they must not be unified.** `end` sets `effective_to = CURRENT_DATE`, so an assignment ended today has `effective_to` equal to today, and the two places that ask whether it is active want opposite answers:

| Question | Asked by | Predicate |
|---|---|---|
| Does this block a new assignment? | `AssignmentsService.create` (this task) | `effective_to IS NULL OR effective_to > CURRENT_DATE` |
| Does this student ride today? | `AbacScopeService` (Task 6) | `effective_to IS NULL OR effective_to >= CURRENT_DATE` |

A route change on the day it happens needs the first to be `>`: ending the old assignment must free the slot immediately, or the replacement collides and the change is impossible until tomorrow. The driver's list needs the second to be `>=`: a child riding today is still on the bus this afternoon even though their assignment ends tonight.

The asymmetry is deliberate and looks like an inconsistency worth tidying. It is not. Changing either one breaks a real day in a school office.

- [ ] **Step 2: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- assignments.service`
Expected: FAIL — `Cannot find module './assignments.service'`.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/transport/assignments/dto/create-assignment.dto.ts`:
```ts
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { AssignmentDirection } from '../../../entities/student-route-assignment.entity';

const DIRECTIONS: AssignmentDirection[] = ['morning', 'afternoon', 'both'];

export class CreateAssignmentDto {
  @IsUUID()
  routeId: string;

  @IsUUID()
  stopId: string;

  @IsIn(DIRECTIONS)
  direction: AssignmentDirection;

  @IsISO8601()
  effectiveFrom: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;
}
```

`apps/api/src/transport/assignments/dto/assignment-response.dto.ts`:
```ts
import {
  AssignmentDirection,
  StudentRouteAssignment,
} from '../../../entities/student-route-assignment.entity';

export interface AssignmentResponseDto {
  id: string;
  studentId: string;
  routeId: string;
  stopId: string;
  direction: AssignmentDirection;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function toAssignmentResponse(
  assignment: StudentRouteAssignment,
): AssignmentResponseDto {
  return {
    id: assignment.id,
    studentId: assignment.studentId,
    routeId: assignment.routeId,
    stopId: assignment.stopId,
    direction: assignment.direction,
    effectiveFrom: assignment.effectiveFrom,
    effectiveTo: assignment.effectiveTo,
  };
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/transport/assignments/assignments.service.ts`:
```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditService } from '../../audit/audit.service';
import { AccessTokenClaims } from '../../auth/token.service';
import { RouteStop } from '../../entities/route-stop.entity';
import { StudentRouteAssignment } from '../../entities/student-route-assignment.entity';
import { AbacScopeService } from '../abac/abac-scope.service';
import { requireSchoolId } from '../students/students.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly auditService: AuditService,
    private readonly abacScopeService: AbacScopeService,
  ) {}

  async create(
    claims: AccessTokenClaims,
    studentId: string,
    dto: CreateAssignmentDto,
  ): Promise<StudentRouteAssignment> {
    const schoolId = requireSchoolId(claims);
    await this.abacScopeService.assertCanReadStudent(claims, studentId);

    if (dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom) {
      throw new BadRequestException('effectiveTo must not be before effectiveFrom');
    }

    const manager = this.tenantContextService.getManager();

    // A CHECK constraint cannot span tables (spec §6), so the stop's membership
    // of the route is verified here. RLS keeps this lookup inside the school.
    const onRoute = await manager.getRepository(RouteStop).findOne({
      where: { routeId: dto.routeId, stopId: dto.stopId },
    });
    if (!onRoute) {
      throw new BadRequestException('That stop is not on the given route');
    }

    // Task 5 deliberately left this out of the schema: a student legitimately
    // has an ended assignment and a current one for the same direction, and
    // only the dates distinguish them. `> CURRENT_DATE` rather than `>=` so an
    // assignment ended today frees the slot from today.
    //
    // The direction clause is symmetric on purpose. `direction IN ($2, 'both')`
    // is the shorter form and is wrong in one direction: it catches a new
    // 'morning' against an existing 'both', but lets a new 'both' through when
    // a 'morning' already exists, double-booking the child's morning ride.
    const clash = await manager.query(
      `SELECT id FROM transport.student_route_assignments
        WHERE student_id = $1
          AND (direction = $2 OR direction = 'both' OR $2 = 'both')
          AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
        LIMIT 1`,
      [studentId, dto.direction],
    );
    if (clash.length > 0) {
      throw new ConflictException(
        `That student already has an active '${dto.direction}' assignment`,
      );
    }

    const assignment = await manager.getRepository(StudentRouteAssignment).save({
      schoolId,
      studentId,
      routeId: dto.routeId,
      stopId: dto.stopId,
      direction: dto.direction,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo ?? null,
    });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'assignment.created',
      entityType: 'student_route_assignment',
      entityId: assignment.id,
      metadata: { studentId, routeId: dto.routeId, stopId: dto.stopId },
    });

    return assignment;
  }

  async list(
    claims: AccessTokenClaims,
    studentId: string,
  ): Promise<StudentRouteAssignment[]> {
    await this.abacScopeService.assertCanReadStudent(claims, studentId);

    // History included, not just the active row: an operator reconstructing
    // which bus a child rode last term needs the ended assignments too.
    return this.tenantContextService
      .getManager()
      .getRepository(StudentRouteAssignment)
      .find({ where: { studentId }, order: { effectiveFrom: 'DESC' } });
  }

  /**
   * Ends an assignment. Never deletes it — Sub-project 6 reads this history to
   * calculate a mid-year fee adjustment, and the audit action is
   * `assignment.ended` for the same reason.
   */
  async end(
    claims: AccessTokenClaims,
    studentId: string,
    assignmentId: string,
  ): Promise<StudentRouteAssignment> {
    const schoolId = requireSchoolId(claims);
    const repository = this.tenantContextService
      .getManager()
      .getRepository(StudentRouteAssignment);

    // Scoped by student as well as id, so a mismatched pair is a 404 rather
    // than silently ending some other child's assignment.
    const assignment = await repository.findOne({ where: { id: assignmentId, studentId } });
    if (!assignment) {
      throw new NotFoundException('Assignment not found for that student');
    }

    const endedOn = new Date().toISOString().slice(0, 10);
    const ended = await repository.save({ ...assignment, effectiveTo: endedOn });

    await this.auditService.record({
      schoolId,
      actorUserId: claims.sub,
      action: 'assignment.ended',
      entityType: 'student_route_assignment',
      entityId: ended.id,
      metadata: { studentId, effectiveTo: endedOn },
    });

    return ended;
  }
}
```

Add a test for the asymmetric case the comment describes, since the suite above does not yet cover it — create a `morning` assignment for a fresh student, then attempt a `both` assignment for that same student and expect `ConflictException`. With the symmetric predicate it passes; with `direction IN ($2, 'both')` it fails, which is exactly what makes it worth writing.

- [ ] **Step 5: Write the controller and module**

`apps/api/src/transport/assignments/assignments.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../auth/token.service';
import { AssignmentsService } from './assignments.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { AssignmentResponseDto, toAssignmentResponse } from './dto/assignment-response.dto';

@Controller('students/:studentId/assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Roles('school_admin')
  @Post()
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: CreateAssignmentDto,
  ): Promise<AssignmentResponseDto> {
    return toAssignmentResponse(await this.assignmentsService.create(user, studentId, dto));
  }

  @Roles('school_admin', 'parent', 'driver', 'attendant')
  @Get()
  async list(
    @CurrentUser() user: AccessTokenClaims,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<AssignmentResponseDto[]> {
    const assignments = await this.assignmentsService.list(user, studentId);
    return assignments.map(toAssignmentResponse);
  }

  // Returns the end-dated row rather than 204, because the caller needs to see
  // the date it was ended on — this is not a deletion.
  @Roles('school_admin')
  @Delete(':assignmentId')
  async end(
    @CurrentUser() user: AccessTokenClaims,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ): Promise<AssignmentResponseDto> {
    return toAssignmentResponse(await this.assignmentsService.end(user, studentId, assignmentId));
  }
}
```

The controller is mounted at `students/:studentId/assignments` rather than being folded into `StudentsController`, so `StudentsController` stays focused and the two can be reviewed apart. Nest resolves the two controllers' routes independently; there is no conflict.

`apps/api/src/transport/assignments/assignments.module.ts` imports `AuthModule`, `AuditModule` and `TransportAbacModule`, declares `AssignmentsController`, and provides `AssignmentsService`.

- [ ] **Step 6: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- assignments.service`
Expected: PASS, 10 tests — the nine written in Step 1 plus the symmetric-direction case added in Step 4.

- [ ] **Step 7: Prove the scoping and stop-membership tests bite**

Two checks, both recorded:

Remove the `assertCanReadStudent` call from `list`, re-run — "refuses a parent listing another family's child" must fail. Restore.

Remove the `route_stops` lookup from `create`, re-run — "rejects a stop that is not on the route" must fail. Restore.

- [ ] **Step 8: Run the full suite and commit**

```bash
git add apps/api/src/transport/assignments/
git commit -m "feat: add student route assignments with end-dating and one-active-per-direction"
```

---

### Task 15: `TransportModule` and application wiring

**Files:**
- Create: `apps/api/src/transport/transport.module.ts`
- Modify: `apps/api/src/app.module.ts` — import `TransportModule`
- Modify: `apps/api/src/database/data-source.ts` and `apps/api/src/database/data-source.migration.ts` — register the seven new entities if they are listed explicitly rather than globbed
- Test: `apps/api/src/transport/transport.module.spec.ts`

**Interfaces:**
- Consumes: `StudentsModule`, `VehiclesModule`, `StopsModule`, `RoutesModule`, `AssignmentsModule`, `TransportAbacModule`.
- Produces: `TransportModule` — a single import for `AppModule`.

- [ ] **Step 1: Check how entities are registered**

Run: `grep -n "entities" apps/api/src/database/data-source.ts apps/api/src/database/data-source.migration.ts`

If the option is a glob (`__dirname + '/../entities/*.entity.{ts,js}'`), the seven new entities are already picked up and no change is needed. If it is an explicit array, add `Student`, `StudentGuardian`, `Vehicle`, `Stop`, `Route`, `RouteStop` and `StudentRouteAssignment` to both files. Do not guess — read the files.

- [ ] **Step 2: Write the failing test**

`apps/api/src/transport/transport.module.spec.ts` — a compile-time wiring test. It builds the real application module graph and asserts every transport provider resolves. This catches a missing `imports` entry, which is otherwise only discovered when a request 500s at runtime.

```ts
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { AbacScopeService } from './abac/abac-scope.service';
import { StudentsService } from './students/students.service';
import { GuardiansService } from './students/guardians.service';
import { VehiclesService } from './vehicles/vehicles.service';
import { StopsService } from './stops/stops.service';
import { RoutesService } from './routes/routes.service';
import { RouteStopsService } from './routes/route-stops.service';
import { AssignmentsService } from './assignments/assignments.service';

describe('TransportModule wiring', () => {
  it('resolves every transport provider from the real application graph', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    for (const provider of [
      AbacScopeService,
      StudentsService,
      GuardiansService,
      VehiclesService,
      StopsService,
      RoutesService,
      RouteStopsService,
      AssignmentsService,
    ]) {
      expect(moduleRef.get(provider, { strict: false })).toBeDefined();
    }

    await moduleRef.close();
  });
});
```

`await moduleRef.close()` is not optional. Foundations' final review found a connection leak from test apps that were never closed, and per-test app creation exhausted `max_connections`. Every test that compiles a module closes it.

- [ ] **Step 3: Run the test and watch it fail**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- transport.module`
Expected: FAIL — the transport providers are not in the graph.

- [ ] **Step 4: Write the module**

`apps/api/src/transport/transport.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TransportAbacModule } from './abac/abac.module';
import { StudentsModule } from './students/students.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { StopsModule } from './stops/stops.module';
import { RoutesModule } from './routes/routes.module';
import { AssignmentsModule } from './assignments/assignments.module';

@Module({
  imports: [
    TransportAbacModule,
    StudentsModule,
    VehiclesModule,
    StopsModule,
    RoutesModule,
    AssignmentsModule,
  ],
})
export class TransportModule {}
```

- [ ] **Step 5: Import it into the application**

In `apps/api/src/app.module.ts`, add `TransportModule` to the `imports` array after `SchoolsModule`. Change nothing else — the guard, interceptor and filter ordering in `providers` is load-bearing (rate-limit, then authenticate, then authorize; the tenancy transaction wrapping the response envelope), and it already covers the new controllers.

- [ ] **Step 6: Run the test and watch it pass**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test -- transport.module`
Expected: PASS, 1 test. Then the full unit suite twice, plus `pnpm --filter @transitos/api lint` and `pnpm --filter @transitos/api build`, all clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transport/transport.module.ts apps/api/src/app.module.ts apps/api/src/database/
git commit -m "feat: wire transport module into the application"
```

---

### Task 16: End-to-end proof and documentation

**Files:**
- Create: `apps/api/test/transport-abac.e2e-spec.ts`
- Create: `apps/api/test/transport-lifecycle.e2e-spec.ts`
- Modify: `README.md` — a transport API section
- Modify: `docs/DECISIONS.md` — record anything ruled during 2a

**Interfaces:**
- Consumes: `createTestApp()` from `test/helpers/app`; `TenantContextService`; `PasswordService`; the HTTP surface built in Tasks 8–15.
- Produces: no source, but the sub-project's acceptance evidence.

**Why both service tests and these.** Every restriction so far was proved at the service layer, where the claims object is constructed by the test. These prove the same restrictions **over HTTP**, where the claims come from a real login and a real JWT, and where the guards, the tenancy interceptor, the response envelope and the exception filter all sit in the path. Spec §8 requires the parent case specifically to be verified this way — a service-layer proof cannot show that the wiring delivers it.

- [ ] **Step 1: Write the ABAC e2e test**

`apps/api/test/transport-abac.e2e-spec.ts`. Seed, through `runWithTenant` as super_admin: one school; a `school_admin`, a `parent` and a `driver`, all with the password `Correct-Horse9!` hashed by `PasswordService`; two students; a `student_guardians` row linking the parent to the **first** student only; a route with `default_driver_user_id` set to the driver, one stop, one `route_stops` row, and an active assignment putting the first student on it. Every email carries a `randomUUID()`.

Then, logging in over HTTP for each role and using the returned `accessToken`:

```ts
  it('shows a parent only their own child', async () => {
    const token = await login(parentEmail);

    const list = await request(app.getHttpServer())
      .get('/students')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].id).toBe(ownChildId);

    await request(app.getHttpServer())
      .get(`/students/${otherChildId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('shows a driver the students on their route and no guardian details', async () => {
    const token = await login(driverEmail);

    const list = await request(app.getHttpServer())
      .get('/students')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(list.body.data.items.map((student: { id: string }) => student.id)).toEqual([ownChildId]);
    // The student response is an allow-list with nowhere to put contact details.
    expect(JSON.stringify(list.body.data.items)).not.toContain(parentEmail);
  });

  it('refuses a parent the write endpoints entirely', async () => {
    const token = await login(parentEmail);

    await request(app.getHttpServer())
      .post('/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ admissionNumber: 'ADM-X', fullName: 'Injected', grade: '1' })
      .expect(403);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(app.getHttpServer()).get('/students').expect(401);
  });
```

`login` is a local helper posting to `/auth/login` and returning `body.data.accessToken`.

Assert on `body.data` throughout — `ResponseInterceptor` wraps every response in `{ success, data }`, and a test asserting on `body.items` would pass vacuously against `undefined` in some matchers.

- [ ] **Step 2: Write the lifecycle e2e test**

`apps/api/test/transport-lifecycle.e2e-spec.ts` walks spec §8's first acceptance criterion as one `school_admin` session, each step over HTTP:

1. `POST /students` → 201, capture id
2. `POST /students/:id/guardians` → 201
3. `POST /vehicles` → 201
4. `POST /stops` twice → 201, capture both ids
5. `POST /routes` with the vehicle as default → 201
6. `PUT /routes/:id/stops` with both stops in order → 200, `sequence` 1 and 2
7. `GET /routes/:id/stops` → 200, same order
8. `POST /students/:id/assignments` on the first stop → 201
9. `GET /students/:id/assignments` → 200, one row, `effectiveTo` null
10. `DELETE /students/:id/assignments/:assignmentId` → 200, `effectiveTo` is today
11. `GET /students/:id/assignments` → 200, **still one row** — the end-date did not delete it

Then one query, as super_admin through `runWithTenant`, asserting the audit trail for the whole walk:

```ts
  it('audited every mutation in the walkthrough', async () => {
    const rows = await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) =>
        manager.query(
          `SELECT action FROM audit.audit_logs WHERE school_id = $1 ORDER BY created_at`,
          [schoolId],
        ),
    );

    expect(rows.map((row: { action: string }) => row.action)).toEqual([
      'student.created',
      'guardian.linked',
      'vehicle.created',
      'stop.created',
      'stop.created',
      'route.created',
      'route.stops_replaced',
      'assignment.created',
      'assignment.ended',
    ]);
  });
```

That single assertion is the acceptance evidence for spec §5 — it shows not only that auditing happens but that it happens for *every* mutation, in order, with none missing. If the list does not match exactly, find the missing `AuditService.record` call rather than relaxing the assertion.

Also add a 400 case, proving the domain error reaches the client as a 400 rather than a 500:

```ts
  it('rejects an assignment to a stop that is not on the route', async () => {
    await request(app.getHttpServer())
      .post(`/students/${studentId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ routeId, stopId: unusedStopId, direction: 'morning', effectiveFrom: today })
      .expect(400);
  });
```

- [ ] **Step 3: Run the e2e suite**

Run: `set -a && . ./.env && set +a && pnpm --filter @transitos/api test:e2e`
Expected: PASS — the two new files plus the two from Foundations.

Both new files must close their app in `afterAll`.

- [ ] **Step 4: Update the README**

Add a "Transport API" section documenting the endpoint table from spec §4, and three points a reader will otherwise get wrong:

- Reads are role-gated *and* row-scoped. `GET /students` returns a different set to a parent, a driver and a school_admin, and that narrowing lives in `AbacScopeService`, not in RLS.
- `DELETE /students/:id/assignments/:assignmentId` end-dates; it does not delete. It returns the updated row.
- `PUT /routes/:id/stops` replaces the whole ordered list. Sequence numbers come from array position; sending your own is not supported.

Keep the existing README structure and voice; this is a new section, not a rewrite.

- [ ] **Step 5: Update `docs/DECISIONS.md`**

Append any ruling made while implementing 2a, in the file's existing format with its cost-if-wrong column. At minimum:

- The two active-assignment predicates differ on purpose (`>` for the conflict check, `>=` for `AbacScopeService`), because they answer different questions. Cost if wrong: either a student who changed routes today vanishes from their new driver's list, or a route change is impossible on the day it happens.
- Out-of-scope routes return 404 while out-of-scope students return 403. Cost if wrong: a 403 on routes tells a driver which route ids exist in the school.
- Guardian links are hard-deleted while students and assignments are not. Cost if wrong: either an unrecoverable history gap, or unbounded growth of revoked links nothing reads.

- [ ] **Step 6: Full verification**

All four, in order, from the repository root with the environment loaded:

```bash
set -a && . ./.env && set +a
pnpm --filter @transitos/api lint
pnpm --filter @transitos/api build
pnpm --filter @transitos/api test
pnpm --filter @transitos/api test        # twice — the database persists between runs
pnpm --filter @transitos/api test:e2e
```

Report the actual counts. A suite that passes once and fails on the second run has fixture collision, not flakiness, and must be fixed rather than re-run.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test/ README.md docs/DECISIONS.md
git commit -m "test: prove transport ABAC and lifecycle over HTTP; document the API"
```
