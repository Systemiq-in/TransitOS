# TransitOS Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-tenant identity/auth substrate for TransitOS — a NestJS API with Argon2id password auth, TOTP MFA, RBAC, immutable audit logging, and Postgres Row-Level Security that makes cross-school data leakage impossible even if application code forgets a filter.

**Architecture:** A pnpm-workspace monorepo containing one NestJS modular monolith (`apps/api`). PostgreSQL holds all state across two schemas (`core`, `audit`). Two Postgres roles exist: a migration role that owns the schema and runs DDL, and a lower-privilege app role the API connects as — which has no `UPDATE`/`DELETE` grant on audit logs and is subject to RLS policies. Each authenticated request opens a transaction, stamps the caller's tenant identity into Postgres session variables (`SET LOCAL app.current_school_id`, `app.is_super_admin`, `app.current_user_id`), and runs every query inside it, so RLS policies filter rows at the database.

**Tech Stack:** TypeScript, NestJS 10, TypeORM 0.3, PostgreSQL 16, `argon2`, `otplib`, `zod`, `class-validator`, `@nestjs/jwt`, `@nestjs/throttler`, Jest + Supertest, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-foundations-design.md` (governed by `docs/superpowers/specs/engineering-standards.md`)

## Global Constraints

- Node.js >= 20, pnpm >= 9, PostgreSQL 16, Redis 7 (provisioned but unused this sub-project).
- Password hashing is **Argon2id only** — never bcrypt, never a fast hash.
- Password policy: minimum 12 characters, at least one uppercase, one lowercase, one number, one symbol; reject common passwords; reject reuse of the last 5 passwords.
- Access token TTL: 15 minutes. Refresh token TTL: 7 days. MFA challenge token TTL: 5 minutes, single use.
- Roles are exactly: `super_admin`, `school_admin`, `driver`, `attendant`, `parent`.
- MFA (TOTP) applies to `super_admin` and `school_admin` only.
- Every table gets `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also get `updated_at timestamptz NOT NULL DEFAULT now()`.
- All tenant-scoped tables get `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` in the same migration that creates them.
- Secrets come from environment variables only, validated at boot by a zod schema that throws on anything missing. Never hardcode a secret, never commit a `.env`.
- Never log passwords, tokens, TOTP secrets, or password hashes.
- TDD: every task writes a failing test first, watches it fail, then implements.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`, `fix:`).

## File Structure

```
TransitOS/
├── pnpm-workspace.yaml                     # workspace definition
├── package.json                            # root scripts, shared devDeps
├── docker-compose.yml                      # postgres:16, redis:7
├── .env.example                            # every env var, documented, no real values
├── .gitignore
├── .github/workflows/ci.yml                # lint + unit + integration + e2e
└── apps/api/
    ├── package.json
    ├── tsconfig.json
    ├── nest-cli.json
    ├── jest.config.ts                      # unit + integration tests
    ├── test/
    │   ├── jest-e2e.config.ts
    │   ├── global-setup.ts                 # bootstrap + migrate the test DB
    │   ├── helpers/app.ts                  # boot a Nest app for e2e
    │   └── *.e2e-spec.ts
    ├── scripts/bootstrap-db.ts             # idempotently create the app role
    └── src/
        ├── main.ts                         # bootstrap, global pipes/filters
        ├── app.module.ts                   # wires every module
        ├── config/
        │   ├── env.schema.ts               # zod schema — the single source of truth for env
        │   └── config.module.ts
        ├── database/
        │   ├── data-source.ts              # app-role DataSource (RLS applies)
        │   ├── data-source.migration.ts    # migration-role DataSource (DDL)
        │   └── migrations/*.ts
        ├── tenancy/
        │   ├── tenant-context.ts           # AsyncLocalStorage store
        │   ├── tenant-context.service.ts    # getManager(), runWithTenant()
        │   └── tenancy.interceptor.ts      # opens txn, SET LOCAL, commits/rolls back
        ├── auth/
        │   ├── password.service.ts         # Argon2id hash/verify
        │   ├── password-policy.ts          # policy validator + common-password list
        │   ├── token.service.ts            # access/challenge JWT issue+verify
        │   ├── refresh-token.service.ts    # issue/rotate/revoke, device fingerprint
        │   ├── mfa.service.ts              # TOTP secret gen, encrypt, verify
        │   ├── auth.service.ts             # login/refresh/logout orchestration
        │   ├── auth.controller.ts
        │   ├── dto/*.ts
        │   ├── guards/{jwt-auth,roles}.guard.ts
        │   └── decorators/{roles,public,current-user}.decorator.ts
        ├── crypto/secret-box.ts            # AES-256-GCM encrypt/decrypt for TOTP secrets
        ├── entities/                       # TypeORM entities, one file each
        ├── audit/audit.service.ts          # append-only audit writer
        ├── users/                          # users.service.ts, users.controller.ts
        ├── schools/                        # schools.service.ts, schools.controller.ts
        ├── health/health.controller.ts
        └── common/
            ├── response.interceptor.ts     # {success, data} envelope
            └── http-exception.filter.ts    # {success:false, error} envelope
```

**Why these boundaries:** auth is split by *responsibility* (password hashing, JWT minting, refresh-token lifecycle, MFA, orchestration) rather than lumped into one `auth.service.ts`, because each has its own test surface and each is independently reusable — Sub-project 2 will need `PasswordService` and `TokenService` without dragging in MFA. `tenancy/` is deliberately separate from `auth/`: authentication decides *who* you are, tenancy decides *what the database will show you*, and conflating them is how RLS bugs get introduced.

---

### Task 1: Monorepo scaffold, NestJS boot, health endpoint, CI

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `.gitignore`, `docker-compose.yml`, `.github/workflows/ci.yml`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`, `apps/api/jest.config.ts`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health/health.controller.ts`
- Test: `apps/api/src/health/health.controller.spec.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a bootable Nest app exporting `AppModule` from `src/app.module.ts`; `pnpm --filter @transitos/api test` runs Jest.

- [ ] **Step 1: Create the workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
```

`package.json`:
```json
{
  "name": "transitos",
  "private": true,
  "engines": { "node": ">=20", "pnpm": ">=9" },
  "scripts": {
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "test:e2e": "pnpm -r test:e2e"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
*.log
coverage/
```

- [ ] **Step 2: Create the API package**

`apps/api/package.json`:
```json
{
  "name": "@transitos/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start:dev": "nest start --watch",
    "lint": "eslint \"{src,test,scripts}/**/*.ts\"",
    "test": "jest",
    "test:e2e": "jest --config ./test/jest-e2e.config.ts --runInBand",
    "db:bootstrap": "ts-node scripts/bootstrap-db.ts",
    "migration:run": "typeorm-ts-node-commonjs migration:run -d src/database/data-source.migration.ts",
    "migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/database/data-source.migration.ts",
    "seed": "ts-node scripts/seed.ts"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.0",
    "@nestjs/config": "^3.2.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/throttler": "^6.2.0",
    "@nestjs/typeorm": "^10.0.2",
    "argon2": "^0.41.1",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "otplib": "^12.0.1",
    "pg": "^8.12.0",
    "qrcode": "^1.5.4",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typeorm": "^0.3.20",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/testing": "^10.4.0",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "@types/qrcode": "^1.5.5",
    "@types/supertest": "^6.0.2",
    "@typescript-eslint/eslint-plugin": "^7.18.0",
    "@typescript-eslint/parser": "^7.18.0",
    "eslint": "^8.57.0",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.4"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "moduleResolution": "node",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true
  },
  "include": ["src/**/*", "test/**/*", "scripts/**/*"]
}
```

`apps/api/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

`apps/api/jest.config.ts`:
```ts
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'src/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  collectCoverageFrom: ['src/**/*.ts'],
  testEnvironment: 'node',
};

export default config;
```

- [ ] **Step 3: Write the failing test**

`apps/api/src/health/health.controller.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports the service as up', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    const controller = moduleRef.get(HealthController);

    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 4: Run the test and watch it fail**

Run: `pnpm install && pnpm --filter @transitos/api test`
Expected: FAIL — `Cannot find module './health.controller'`.

- [ ] **Step 5: Implement the app**

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('healthz')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  imports: [],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test`
Expected: PASS, 1 test.

- [ ] **Step 7: Add Docker Compose and CI**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: transitos_migrator
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-devpassword}
      POSTGRES_DB: transitos
    ports: ["5432:5432"]
    volumes: ["transitos_pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U transitos_migrator -d transitos"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7
    ports: ["6379:6379"]

volumes:
  transitos_pgdata:
```

`.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: transitos_migrator
          POSTGRES_PASSWORD: devpassword
          POSTGRES_DB: transitos_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U transitos_migrator"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_MIGRATION_URL: postgres://transitos_migrator:devpassword@localhost:5432/transitos_test
      DATABASE_URL: postgres://transitos_app:apppassword@localhost:5432/transitos_test
      APP_DB_ROLE: transitos_app
      APP_DB_PASSWORD: apppassword
      JWT_SECRET: ci-test-secret-value-at-least-32-chars-long
      MFA_ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm --filter @transitos/api test:e2e
```

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json .gitignore docker-compose.yml .github apps/
git commit -m "feat: scaffold pnpm monorepo with NestJS api, health endpoint, and CI"
```

---

### Task 2: Environment configuration with fail-fast validation

**Files:**
- Create: `apps/api/src/config/env.schema.ts`, `apps/api/src/config/config.module.ts`, `.env.example`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/config/env.schema.spec.ts`

**Interfaces:**
- Consumes: `AppModule` from Task 1.
- Produces: `envSchema` (zod), `type Env = z.infer<typeof envSchema>`, `validateEnv(raw: Record<string, unknown>): Env`, and `AppConfigModule` (a global module exposing `ConfigService<Env, true>`).

- [ ] **Step 1: Write the failing test**

`apps/api/src/config/env.schema.spec.ts`:
```ts
import { validateEnv } from './env.schema';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://app:pw@localhost:5432/transitos',
  DATABASE_MIGRATION_URL: 'postgres://mig:pw@localhost:5432/transitos',
  APP_DB_ROLE: 'transitos_app',
  APP_DB_PASSWORD: 'apppassword',
  JWT_SECRET: 'a'.repeat(32),
  MFA_ENCRYPTION_KEY: '0'.repeat(64),
};

describe('validateEnv', () => {
  it('accepts a complete environment and coerces PORT to a number', () => {
    const env = validateEnv(validEnv);
    expect(env.PORT).toBe(3000);
    expect(env.APP_DB_ROLE).toBe('transitos_app');
  });

  it('throws when a required variable is missing', () => {
    const { JWT_SECRET, ...incomplete } = validEnv;
    expect(() => validateEnv(incomplete)).toThrow(/JWT_SECRET/);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => validateEnv({ ...validEnv, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects an MFA key that is not 64 hex characters', () => {
    expect(() => validateEnv({ ...validEnv, MFA_ENCRYPTION_KEY: 'nothex' })).toThrow(
      /MFA_ENCRYPTION_KEY/,
    );
  });

  it('rejects an app DB role that is not a safe SQL identifier', () => {
    expect(() => validateEnv({ ...validEnv, APP_DB_ROLE: 'bad-role; DROP TABLE users' })).toThrow(
      /APP_DB_ROLE/,
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- env.schema`
Expected: FAIL — `Cannot find module './env.schema'`.

- [ ] **Step 3: Implement the schema**

`apps/api/src/config/env.schema.ts`:
```ts
import { z } from 'zod';

/**
 * APP_DB_ROLE is interpolated into DDL (GRANT statements) by migrations, where
 * Postgres offers no parameter binding for identifiers. Constraining it to a plain
 * lowercase identifier here is what makes that interpolation safe.
 */
const sqlIdentifier = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/, 'APP_DB_ROLE must be a lowercase SQL identifier');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATION_URL: z.string().url(),
  APP_DB_ROLE: sqlIdentifier,
  APP_DB_PASSWORD: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  MFA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'MFA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return result.data;
}
```

`apps/api/src/config/config.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true })],
  exports: [ConfigModule],
})
export class AppConfigModule {}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- env.schema`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the app and document the variables**

In `apps/api/src/app.module.ts`, add `AppConfigModule` to `imports`:
```ts
import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [AppConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
```

`.env.example` (no real values — every entry is a placeholder):
```bash
NODE_ENV=development
PORT=3000

# App role: what the running API connects as. Subject to RLS, cannot mutate audit logs.
DATABASE_URL=postgres://transitos_app:CHANGE_ME@localhost:5432/transitos
# Migration role: owns the schema, runs DDL. Never used by the running API.
DATABASE_MIGRATION_URL=postgres://transitos_migrator:CHANGE_ME@localhost:5432/transitos
APP_DB_ROLE=transitos_app
APP_DB_PASSWORD=CHANGE_ME

# Min 32 chars. Generate with: openssl rand -base64 48
JWT_SECRET=CHANGE_ME
# Exactly 64 hex chars (32 bytes). Generate with: openssl rand -hex 32
MFA_ENCRYPTION_KEY=CHANGE_ME

ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=604800
MFA_CHALLENGE_TTL_SECONDS=300
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config apps/api/src/app.module.ts .env.example
git commit -m "feat: add zod-validated environment configuration that fails fast at boot"
```

---

### Task 3: Database bootstrap, data sources, and the initial schema migration

**Files:**
- Create: `apps/api/scripts/bootstrap-db.ts`, `apps/api/src/database/data-source.migration.ts`, `apps/api/src/database/data-source.ts`
- Create: `apps/api/src/database/migrations/1757030000000-InitSchemas.ts`
- Test: `apps/api/src/database/migrations/init-schemas.spec.ts`

**Interfaces:**
- Consumes: `validateEnv`/`Env` from Task 2.
- Produces: `migrationDataSource` (DataSource, migration role) and `appDataSourceOptions` (`DataSourceOptions`, app role) — every later migration is appended to `src/database/migrations/`; every later task's integration test connects via `appDataSourceOptions`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/init-schemas.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('InitSchemas migration', () => {
  let migrator: DataSource;
  let app: DataSource;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('creates the core and audit schemas', async () => {
    const rows = await migrator.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('core','audit') ORDER BY schema_name`,
    );
    expect(rows.map((r: { schema_name: string }) => r.schema_name)).toEqual(['audit', 'core']);
  });

  it('enables pgcrypto so gen_random_uuid() is available', async () => {
    const [row] = await migrator.query(`SELECT gen_random_uuid() AS id`);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lets the app role connect and use both schemas', async () => {
    const [row] = await app.query(`SELECT current_user AS role`);
    expect(row.role).toBe(process.env.APP_DB_ROLE);
  });

  it('does not grant the app role permission to create tables in core', async () => {
    const [row] = await app.query(
      `SELECT has_schema_privilege(current_user, 'core', 'CREATE') AS can_create`,
    );
    expect(row.can_create).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `docker compose up -d postgres && pnpm --filter @transitos/api test -- init-schemas`
Expected: FAIL — `Cannot find module '../data-source.migration'`.

- [ ] **Step 3: Implement the bootstrap script and data sources**

`apps/api/scripts/bootstrap-db.ts` — creates the app role idempotently. Run as the migration role before migrations, locally and in CI.
```ts
import 'reflect-metadata';
import { Client } from 'pg';
import { validateEnv } from '../src/config/env.schema';

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const client = new Client({ connectionString: env.DATABASE_MIGRATION_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      env.APP_DB_ROLE,
    ]);
    if (rowCount === 0) {
      // Identifier is validated as a plain SQL identifier by envSchema; the password
      // is passed through pg's literal quoting rather than interpolated raw.
      const quotedPassword = (await client.query('SELECT quote_literal($1) AS q', [
        env.APP_DB_PASSWORD,
      ])).rows[0].q;
      await client.query(`CREATE ROLE ${env.APP_DB_ROLE} LOGIN PASSWORD ${quotedPassword}`);
      console.log(`Created role ${env.APP_DB_ROLE}`);
    } else {
      console.log(`Role ${env.APP_DB_ROLE} already exists`);
    }
    const dbName = new URL(env.DATABASE_MIGRATION_URL).pathname.slice(1);
    await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${env.APP_DB_ROLE}`);
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

`apps/api/src/database/data-source.migration.ts`:
```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.schema';

const env = validateEnv(process.env);

export const migrationDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_MIGRATION_URL,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  migrationsTableName: 'schema_migrations',
  synchronize: false,
  logging: false,
});
```

`apps/api/src/database/data-source.ts`:
```ts
import { DataSourceOptions } from 'typeorm';
import { validateEnv } from '../config/env.schema';

const env = validateEnv(process.env);

/**
 * The options the running API uses. Note: no `migrations` and `synchronize: false` —
 * the app role has no DDL rights, and schema changes only ever come from the
 * migration role. Entities are registered by each feature module.
 */
export const appDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [__dirname + '/../entities/*.entity.{ts,js}'],
  synchronize: false,
  logging: false,
};
```

- [ ] **Step 4: Write the initial migration**

`apps/api/src/database/migrations/1757030000000-InitSchemas.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class InitSchemas1757030000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS core`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS audit`);

    // USAGE lets the app role reference objects in these schemas; it deliberately
    // gets no CREATE, so it can never add or alter tables.
    await queryRunner.query(`GRANT USAGE ON SCHEMA core TO ${appRole}`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA audit TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS audit CASCADE`);
    await queryRunner.query(`DROP SCHEMA IF EXISTS core CASCADE`);
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run:
```bash
export $(grep -v '^#' .env | xargs)   # or set env vars however you prefer
pnpm --filter @transitos/api db:bootstrap
pnpm --filter @transitos/api test -- init-schemas
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts apps/api/src/database
git commit -m "feat: add app/migration db roles, data sources, and initial schema migration"
```

---

### Task 4: `core.schools` table with tenant RLS policies

**Files:**
- Create: `apps/api/src/entities/school.entity.ts`
- Create: `apps/api/src/database/migrations/1757030100000-CreateSchools.ts`
- Test: `apps/api/src/database/migrations/create-schools.spec.ts`

**Interfaces:**
- Consumes: `migrationDataSource`, `appDataSourceOptions` (Task 3).
- Produces: `School` entity with fields `id: string`, `name: string`, `locale: string`, `timezone: string`, `status: 'active' | 'suspended'`, `createdAt: Date`, `updatedAt: Date`. Session variables established here — `app.is_super_admin` (`'true'`/`'false'`) and `app.current_school_id` (uuid string or `''`) — are the contract every later RLS policy and the tenancy interceptor rely on.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-schools.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('core.schools RLS', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let schoolB: string;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    const [a] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('Greenwood Academy') RETURNING id`,
    );
    const [b] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('Springfield School') RETURNING id`,
    );
    schoolA = a.id;
    schoolB = b.id;
    await runner.commitTransaction();
    await runner.release();
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('shows a school-scoped session only its own school row', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'false'`);
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);

    const rows = await runner.query(`SELECT id FROM core.schools`);

    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(schoolA);
  });

  it('shows a super_admin session every school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);

    const rows = await runner.query(`SELECT id FROM core.schools`);

    await runner.rollbackTransaction();
    await runner.release();

    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([schoolA, schoolB].sort());
  });

  it('shows nothing at all when no tenant context has been set', async () => {
    const rows = await app.query(`SELECT id FROM core.schools`);
    expect(rows).toHaveLength(0);
  });

  it('refuses to let a school-scoped session insert a new school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'false'`);
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);

    await expect(
      runner.query(`INSERT INTO core.schools (name) VALUES ('Rogue School')`),
    ).rejects.toThrow(/row-level security/i);

    await runner.rollbackTransaction();
    await runner.release();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- create-schools`
Expected: FAIL — `relation "core.schools" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030100000-CreateSchools.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateSchools1757030100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE core.schools (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        locale text NOT NULL DEFAULT 'en-IN',
        timezone text NOT NULL DEFAULT 'Asia/Kolkata',
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // FORCE makes the policies apply to the table owner too, not just other roles.
    await queryRunner.query(`ALTER TABLE core.schools ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE core.schools FORCE ROW LEVEL SECURITY`);

    await queryRunner.query(`
      CREATE POLICY schools_super_admin_all ON core.schools
        FOR ALL
        USING (current_setting('app.is_super_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_super_admin', true) = 'true')
    `);

    // A school-scoped session may read its own row and nothing else — and may not
    // write here at all, since no INSERT/UPDATE policy matches it.
    await queryRunner.query(`
      CREATE POLICY schools_own_row_select ON core.schools
        FOR SELECT
        USING (id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
    `);

    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON core.schools TO ${appRole}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE core.schools`);
  }
}
```

- [ ] **Step 4: Write the entity**

`apps/api/src/entities/school.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SchoolStatus = 'active' | 'suspended';

@Entity({ schema: 'core', name: 'schools' })
export class School {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: 'en-IN' })
  locale: string;

  @Column({ type: 'text', default: 'Asia/Kolkata' })
  timezone: string;

  @Column({ type: 'text', default: 'active' })
  status: SchoolStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- create-schools`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/entities/school.entity.ts apps/api/src/database/migrations
git commit -m "feat: add core.schools table with row-level security policies"
```

---

### Task 5: `core.users` table, tenant RLS, and the login carve-out policy

**Files:**
- Create: `apps/api/src/entities/user.entity.ts`
- Create: `apps/api/src/database/migrations/1757030200000-CreateUsers.ts`
- Test: `apps/api/src/database/migrations/create-users.spec.ts`

**Interfaces:**
- Consumes: `core.schools` and the session-variable contract (Task 4).
- Produces: `User` entity with `id`, `schoolId: string | null`, `role: UserRole`, `email: string | null`, `phone: string | null`, `passwordHash: string`, `displayName: string`, `status: 'active' | 'disabled'`, `createdAt`, `updatedAt`; and the exported union `type UserRole = 'super_admin' | 'school_admin' | 'driver' | 'attendant' | 'parent'`. Adds a third session variable, `app.auth_lookup`, which grants SELECT-only visibility of users during pre-authentication credential lookup.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-users.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('core.users RLS', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let schoolB: string;

  const asSuperAdmin = async <T>(fn: (q: (sql: string) => Promise<any>) => Promise<T>): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    try {
      return await fn((sql: string) => runner.query(sql));
    } finally {
      await runner.commitTransaction();
      await runner.release();
    }
  };

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    await asSuperAdmin(async (q) => {
      [{ id: schoolA }] = await q(`INSERT INTO core.schools (name) VALUES ('School A') RETURNING id`);
      [{ id: schoolB }] = await q(`INSERT INTO core.schools (name) VALUES ('School B') RETURNING id`);
      await q(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
               VALUES ('${schoolA}', 'school_admin', 'admin-a@example.com', 'hash', 'Admin A')`);
      await q(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
               VALUES ('${schoolB}', 'school_admin', 'admin-b@example.com', 'hash', 'Admin B')`);
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('shows a school-scoped session only its own school users', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);
    const rows = await runner.query(`SELECT email FROM core.users`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows.map((r: { email: string }) => r.email)).toEqual(['admin-a@example.com']);
  });

  it('rejects a school-scoped session inserting a user into another school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);

    await expect(
      runner.query(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
                    VALUES ('${schoolB}', 'parent', 'sneaky@example.com', 'hash', 'Sneaky')`),
    ).rejects.toThrow(/row-level security/i);

    await runner.rollbackTransaction();
    await runner.release();
  });

  it('allows a credential lookup with app.auth_lookup set, with no tenant context', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.auth_lookup = 'true'`);
    const rows = await runner.query(
      `SELECT id, role FROM core.users WHERE email = 'admin-b@example.com'`,
    );
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('school_admin');
  });

  it('grants the auth lookup flag no write power whatsoever', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.auth_lookup = 'true'`);

    // No UPDATE policy matches an auth-lookup session, so the row is invisible to
    // the write and zero rows change — the flag cannot be used to escalate.
    const result = await runner.query(
      `UPDATE core.users SET role = 'super_admin' WHERE email = 'admin-b@example.com'`,
    );

    await runner.rollbackTransaction();
    await runner.release();

    expect(result[1]).toBe(0);
  });

  it('enforces that only super_admin users may have a null school_id', async () => {
    await expect(
      asSuperAdmin((q) =>
        q(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES (NULL, 'parent', 'orphan@example.com', 'hash', 'Orphan')`),
      ),
    ).rejects.toThrow(/users_school_required/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- create-users`
Expected: FAIL — `relation "core.users" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030200000-CreateUsers.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateUsers1757030200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE core.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid REFERENCES core.schools(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (
          role IN ('super_admin', 'school_admin', 'driver', 'attendant', 'parent')
        ),
        email text UNIQUE,
        phone text UNIQUE,
        password_hash text NOT NULL,
        display_name text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_school_required CHECK (role = 'super_admin' OR school_id IS NOT NULL),
        CONSTRAINT users_contact_required CHECK (email IS NOT NULL OR phone IS NOT NULL)
      )
    `);
    await queryRunner.query(`CREATE INDEX users_school_id_idx ON core.users (school_id)`);

    await queryRunner.query(`ALTER TABLE core.users ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE core.users FORCE ROW LEVEL SECURITY`);

    await queryRunner.query(`
      CREATE POLICY users_super_admin_all ON core.users
        FOR ALL
        USING (current_setting('app.is_super_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_super_admin', true) = 'true')
    `);

    await queryRunner.query(`
      CREATE POLICY users_tenant_all ON core.users
        FOR ALL
        USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
        WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
    `);

    // The login carve-out. /auth/login must find a user by email or phone before any
    // tenant context can exist. SELECT only, and only when the credential-lookup
    // query explicitly sets the flag via SET LOCAL inside its own transaction.
    await queryRunner.query(`
      CREATE POLICY users_auth_lookup_select ON core.users
        FOR SELECT
        USING (current_setting('app.auth_lookup', true) = 'true')
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.users TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE core.users`);
  }
}
```

- [ ] **Step 4: Write the entity**

`apps/api/src/entities/user.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type UserRole = 'super_admin' | 'school_admin' | 'driver' | 'attendant' | 'parent';
export type UserStatus = 'active' | 'disabled';

/** Roles that must present a second factor once they have enrolled one. */
export const MFA_ELIGIBLE_ROLES: readonly UserRole[] = ['super_admin', 'school_admin'];

@Entity({ schema: 'core', name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid', nullable: true })
  schoolId: string | null;

  @Column({ type: 'text' })
  role: UserRole;

  @Column({ type: 'text', nullable: true })
  email: string | null;

  @Column({ type: 'text', nullable: true })
  phone: string | null;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName: string;

  @Column({ type: 'text', default: 'active' })
  status: UserStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- create-users`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/entities/user.entity.ts apps/api/src/database/migrations
git commit -m "feat: add core.users with tenant RLS and a select-only login carve-out"
```

---

### Task 6: Session and credential tables (`refresh_tokens`, `password_history`, `mfa_credentials`)

**Files:**
- Create: `apps/api/src/entities/refresh-token.entity.ts`, `apps/api/src/entities/password-history.entity.ts`, `apps/api/src/entities/mfa-credential.entity.ts`
- Create: `apps/api/src/database/migrations/1757030300000-CreateAuthTables.ts`
- Test: `apps/api/src/database/migrations/create-auth-tables.spec.ts`

**Interfaces:**
- Consumes: `core.users` (Task 5).
- Produces: `RefreshToken` (`id`, `userId`, `tokenHash`, `deviceFingerprint`, `deviceInfo: string | null`, `expiresAt: Date`, `revokedAt: Date | null`, `createdAt`), `PasswordHistory` (`id`, `userId`, `passwordHash`, `createdAt`), `MfaCredential` (`id`, `userId`, `secretEncrypted`, `enabledAt: Date | null`, `createdAt`).

**Why no RLS here:** all three are read in flows that run before a tenant or user context exists (login looks up MFA credentials pre-authentication; refresh looks up a token row before knowing who presented it), and `password_history` is written by an admin creating *another* user. They hold no tenant-queryable data and are only reachable via auth flows filtered by a server-derived `user_id`. See the spec, §3.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-auth-tables.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('auth support tables', () => {
  let migrator: DataSource;
  let app: DataSource;
  let userId: string;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    const [user] = await runner.query(
      `INSERT INTO core.users (role, email, password_hash, display_name)
       VALUES ('super_admin', 'root@example.com', 'hash', 'Root') RETURNING id`,
    );
    userId = user.id;
    await runner.commitTransaction();
    await runner.release();
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('stores a refresh token without any tenant context set', async () => {
    const [row] = await app.query(
      `INSERT INTO core.refresh_tokens (user_id, token_hash, device_fingerprint, expires_at)
       VALUES ('${userId}', 'tokenhash', 'fingerprint', now() + interval '7 days')
       RETURNING id, revoked_at`,
    );
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.revoked_at).toBeNull();
  });

  it('rejects two enrolled MFA credentials for the same user', async () => {
    await app.query(
      `INSERT INTO core.mfa_credentials (user_id, secret_encrypted) VALUES ('${userId}', 'cipher')`,
    );
    await expect(
      app.query(
        `INSERT INTO core.mfa_credentials (user_id, secret_encrypted) VALUES ('${userId}', 'cipher2')`,
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('keeps password history rows for a user', async () => {
    await app.query(
      `INSERT INTO core.password_history (user_id, password_hash) VALUES ('${userId}', 'old-hash')`,
    );
    const rows = await app.query(
      `SELECT password_hash FROM core.password_history WHERE user_id = '${userId}'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('cascades deletes from users to their sessions', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    await runner.query(`DELETE FROM core.users WHERE id = '${userId}'`);
    const [{ count }] = await runner.query(
      `SELECT count(*)::int AS count FROM core.refresh_tokens WHERE user_id = '${userId}'`,
    );
    await runner.rollbackTransaction();
    await runner.release();

    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- create-auth-tables`
Expected: FAIL — `relation "core.refresh_tokens" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030300000-CreateAuthTables.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateAuthTables1757030300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE core.refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        device_fingerprint text NOT NULL,
        device_info text,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX refresh_tokens_user_id_idx ON core.refresh_tokens (user_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE core.password_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX password_history_user_id_idx ON core.password_history (user_id, created_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE core.mfa_credentials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE REFERENCES core.users(id) ON DELETE CASCADE,
        secret_encrypted text NOT NULL,
        enabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON core.refresh_tokens, core.password_history, core.mfa_credentials TO ${appRole}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE core.mfa_credentials`);
    await queryRunner.query(`DROP TABLE core.password_history`);
    await queryRunner.query(`DROP TABLE core.refresh_tokens`);
  }
}
```

- [ ] **Step 4: Write the entities**

`apps/api/src/entities/refresh-token.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'core', name: 'refresh_tokens' })
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @Column({ name: 'device_fingerprint', type: 'text' })
  deviceFingerprint: string;

  @Column({ name: 'device_info', type: 'text', nullable: true })
  deviceInfo: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

`apps/api/src/entities/password-history.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'core', name: 'password_history' })
export class PasswordHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

`apps/api/src/entities/mfa-credential.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'core', name: 'mfa_credentials' })
export class MfaCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'secret_encrypted', type: 'text' })
  secretEncrypted: string;

  @Column({ name: 'enabled_at', type: 'timestamptz', nullable: true })
  enabledAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- create-auth-tables`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/entities apps/api/src/database/migrations
git commit -m "feat: add refresh token, password history, and MFA credential tables"
```

---

### Task 7: `audit.audit_logs` with database-enforced immutability

**Files:**
- Create: `apps/api/src/entities/audit-log.entity.ts`
- Create: `apps/api/src/database/migrations/1757030400000-CreateAuditLogs.ts`
- Test: `apps/api/src/database/migrations/create-audit-logs.spec.ts`

**Interfaces:**
- Consumes: `core.users` (Task 5).
- Produces: `AuditLog` entity (`id`, `schoolId: string | null`, `actorUserId: string | null`, `action: string`, `entityType: string | null`, `entityId: string | null`, `ipAddress: string | null`, `metadata: Record<string, unknown>`, `createdAt`). Task 13's `AuditService` writes through this entity.

- [ ] **Step 1: Write the failing test**

`apps/api/src/database/migrations/create-audit-logs.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('audit.audit_logs immutability and visibility', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    [{ id: schoolA }] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('Audited School') RETURNING id`,
    );
    await runner.commitTransaction();
    await runner.release();

    // Writes are always permitted, with or without tenant context — a login has to
    // be auditable before the caller is authenticated.
    await app.query(
      `INSERT INTO audit.audit_logs (school_id, action) VALUES ('${schoolA}', 'user.login')`,
    );
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('refuses UPDATE from the application role', async () => {
    await expect(
      app.query(`UPDATE audit.audit_logs SET action = 'tampered'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses DELETE from the application role', async () => {
    await expect(app.query(`DELETE FROM audit.audit_logs`)).rejects.toThrow(/permission denied/i);
  });

  it('shows a school-scoped session only its own audit rows', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);
    const rows = await runner.query(`SELECT action FROM audit.audit_logs`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([{ action: 'user.login' }]);
  });

  it('hides audit rows from a session scoped to a different school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '00000000-0000-0000-0000-000000000000'`);
    const rows = await runner.query(`SELECT action FROM audit.audit_logs`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- create-audit-logs`
Expected: FAIL — `relation "audit.audit_logs" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/src/database/migrations/1757030400000-CreateAuditLogs.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateAuditLogs1757030400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE audit.audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid,
        actor_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
        action text NOT NULL,
        entity_type text,
        entity_id uuid,
        ip_address inet,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX audit_logs_school_created_idx ON audit.audit_logs (school_id, created_at DESC)`,
    );

    await queryRunner.query(`ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE audit.audit_logs FORCE ROW LEVEL SECURITY`);

    // Writes are unconditional: an audit record must be capturable during login,
    // before any tenant context exists. Reads are tenant-scoped.
    await queryRunner.query(`
      CREATE POLICY audit_logs_insert_any ON audit.audit_logs
        FOR INSERT WITH CHECK (true)
    `);
    await queryRunner.query(`
      CREATE POLICY audit_logs_super_admin_select ON audit.audit_logs
        FOR SELECT USING (current_setting('app.is_super_admin', true) = 'true')
    `);
    await queryRunner.query(`
      CREATE POLICY audit_logs_tenant_select ON audit.audit_logs
        FOR SELECT
        USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
    `);

    // The heart of immutability: the app role is never granted UPDATE or DELETE, so
    // tampering fails at the privilege check, not at a policy or in application code.
    await queryRunner.query(`GRANT SELECT, INSERT ON audit.audit_logs TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE audit.audit_logs`);
  }
}
```

- [ ] **Step 4: Write the entity**

`apps/api/src/entities/audit-log.entity.ts`:
```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ schema: 'audit', name: 'audit_logs' })
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid', nullable: true })
  schoolId: string | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId: string | null;

  @Column({ type: 'text' })
  action: string;

  @Column({ name: 'entity_type', type: 'text', nullable: true })
  entityType: string | null;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId: string | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- create-audit-logs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/entities/audit-log.entity.ts apps/api/src/database/migrations
git commit -m "feat: add append-only audit.audit_logs with tenant-scoped reads"
```

---

### Task 8: AES-256-GCM secret box for encrypting MFA secrets at rest

**Files:**
- Create: `apps/api/src/crypto/secret-box.ts`
- Test: `apps/api/src/crypto/secret-box.spec.ts`

**Interfaces:**
- Consumes: `MFA_ENCRYPTION_KEY` from `Env` (Task 2) — 64 hex chars, i.e. 32 raw bytes.
- Produces: `encryptSecret(plaintext: string, keyHex: string): string` and `decryptSecret(ciphertext: string, keyHex: string): string`, used by `MfaService` (Task 12) to store/read `mfa_credentials.secret_encrypted`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/crypto/secret-box.spec.ts`:
```ts
import { encryptSecret, decryptSecret } from './secret-box';

const key = '0'.repeat(64);
const otherKey = '1'.repeat(64);

describe('secret-box', () => {
  it('round-trips a plaintext string', () => {
    const ciphertext = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(decryptSecret(ciphertext, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces different ciphertext for the same plaintext each call (random IV)', () => {
    const a = encryptSecret('same-secret', key);
    const b = encryptSecret('same-secret', key);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(() => decryptSecret(ciphertext, otherKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext (auth tag check)', () => {
    const ciphertext = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const tampered = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- secret-box`
Expected: FAIL — `Cannot find module './secret-box'`.

- [ ] **Step 3: Implement**

`apps/api/src/crypto/secret-box.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/** Stored/transmitted as `<ivHex>:<authTagHex>:<ciphertextHex>`. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(payload: string, keyHex: string): string {
  const [ivHex, authTagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed secret-box payload');
  }
  const key = Buffer.from(keyHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- secret-box`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/crypto
git commit -m "feat: add AES-256-GCM secret box for encrypting MFA secrets at rest"
```

---

### Task 9: Argon2id password hashing and password-policy validation

**Files:**
- Create: `apps/api/src/auth/password.service.ts`, `apps/api/src/auth/password-policy.ts`, `apps/api/src/auth/common-passwords.ts`
- Test: `apps/api/src/auth/password.service.spec.ts`, `apps/api/src/auth/password-policy.spec.ts`

**Interfaces:**
- Consumes: `argon2` package.
- Produces: `PasswordService` (Nest injectable) with `hash(plain: string): Promise<string>` and `verify(hash: string, plain: string): Promise<boolean>`; `validatePasswordPolicy(password: string): string[]` (returns a list of violation messages, empty if valid); `COMMON_PASSWORDS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/auth/password-policy.spec.ts`:
```ts
import { validatePasswordPolicy } from './password-policy';

describe('validatePasswordPolicy', () => {
  it('accepts a password meeting every rule', () => {
    expect(validatePasswordPolicy('Correct-Horse9!')).toEqual([]);
  });

  it('flags a password shorter than 12 characters', () => {
    expect(validatePasswordPolicy('Sh0rt!')).toContain('must be at least 12 characters');
  });

  it('flags a password with no uppercase letter', () => {
    expect(validatePasswordPolicy('lowercase-only9!')).toContain(
      'must contain an uppercase letter',
    );
  });

  it('flags a password with no lowercase letter', () => {
    expect(validatePasswordPolicy('UPPERCASE-ONLY9!')).toContain(
      'must contain a lowercase letter',
    );
  });

  it('flags a password with no number', () => {
    expect(validatePasswordPolicy('NoNumbersHere!')).toContain('must contain a number');
  });

  it('flags a password with no symbol', () => {
    expect(validatePasswordPolicy('NoSymbolsHere9')).toContain('must contain a symbol');
  });

  it('flags a common password regardless of decoration', () => {
    expect(validatePasswordPolicy('Password123!')).toContain('is too common');
  });

  it('returns every violation for a password that fails multiple rules', () => {
    const violations = validatePasswordPolicy('short');
    expect(violations.length).toBeGreaterThan(1);
  });
});
```

`apps/api/src/auth/password.service.spec.ts`:
```ts
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an Argon2id hash that is not the plaintext', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(hash).not.toBe('Correct-Horse9!');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifies a matching password', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(await service.verify(hash, 'Correct-Horse9!')).toBe(true);
  });

  it('rejects a non-matching password', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(await service.verify(hash, 'Wrong-Password9!')).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await service.hash('Correct-Horse9!');
    const b = await service.hash('Correct-Horse9!');
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @transitos/api test -- password`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/api/src/auth/common-passwords.ts` — a deliberately small seed list; expand later without touching callers:
```ts
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  [
    'password', 'password1', 'password123', '123456', '123456789', 'qwerty',
    'letmein', 'welcome', 'admin123', 'iloveyou', 'monkey123', 'dragon123',
  ].map((p) => p.toLowerCase()),
);

/** Strips common decoration (digits, symbols) so "Password123!" still matches "password". */
export function normalizeForCommonCheck(password: string): string {
  return password.toLowerCase().replace(/[^a-z]/g, '');
}
```

`apps/api/src/auth/password-policy.ts`:
```ts
import { COMMON_PASSWORDS, normalizeForCommonCheck } from './common-passwords';

const MIN_LENGTH = 12;

export function validatePasswordPolicy(password: string): string[] {
  const violations: string[] = [];

  if (password.length < MIN_LENGTH) {
    violations.push(`must be at least ${MIN_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) {
    violations.push('must contain an uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    violations.push('must contain a lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    violations.push('must contain a number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    violations.push('must contain a symbol');
  }
  if (COMMON_PASSWORDS.has(normalizeForCommonCheck(password))) {
    violations.push('is too common');
  }

  return violations;
}
```

`apps/api/src/auth/password.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    return argon2.verify(hash, plain);
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @transitos/api test -- password`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/password.service.ts apps/api/src/auth/password-policy.ts apps/api/src/auth/common-passwords.ts apps/api/src/auth/password.service.spec.ts apps/api/src/auth/password-policy.spec.ts
git commit -m "feat: add Argon2id password hashing and password policy validation"
```

---

### Task 10: JWT access-token and MFA-challenge-token issuance/verification

**Files:**
- Create: `apps/api/src/auth/token.service.ts`
- Test: `apps/api/src/auth/token.service.spec.ts`

**Interfaces:**
- Consumes: `@nestjs/jwt`, `Env` (Task 2).
- Produces: `TokenService` with `signAccessToken(payload: AccessTokenClaims): string`, `verifyAccessToken(token: string): AccessTokenClaims`, `signMfaChallenge(userId: string): string`, `verifyMfaChallenge(token: string): { userId: string }`. Exports `interface AccessTokenClaims { sub: string; schoolId: string | null; role: UserRole; isSuperAdmin: boolean }` — this is the exact shape `JwtAuthGuard` (Task 14) and `TenancyInterceptor` (Task 13) read.

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/token.service.spec.ts`:
```ts
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';
import { Env } from '../config/env.schema';

function buildService(overrides: Partial<Env> = {}): TokenService {
  const env: Env = {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgres://a:b@localhost/db',
    DATABASE_MIGRATION_URL: 'postgres://a:b@localhost/db',
    APP_DB_ROLE: 'transitos_app',
    APP_DB_PASSWORD: 'x',
    JWT_SECRET: 'a'.repeat(32),
    MFA_ENCRYPTION_KEY: '0'.repeat(64),
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_SECONDS: 604800,
    MFA_CHALLENGE_TTL_SECONDS: 300,
    ...overrides,
  };
  const configService = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  return new TokenService(new JwtService(), configService);
}

describe('TokenService', () => {
  it('round-trips access token claims', () => {
    const service = buildService();
    const token = service.signAccessToken({
      sub: 'user-1',
      schoolId: 'school-1',
      role: 'school_admin',
      isSuperAdmin: false,
    });
    expect(service.verifyAccessToken(token)).toMatchObject({
      sub: 'user-1',
      schoolId: 'school-1',
      role: 'school_admin',
      isSuperAdmin: false,
    });
  });

  it('rejects a token signed with a different secret', () => {
    const service = buildService();
    const otherService = buildService({ JWT_SECRET: 'b'.repeat(32) });
    const token = otherService.signAccessToken({
      sub: 'user-1',
      schoolId: null,
      role: 'super_admin',
      isSuperAdmin: true,
    });
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it('rejects an expired access token', () => {
    const service = buildService({ ACCESS_TOKEN_TTL_SECONDS: -1 });
    const token = service.signAccessToken({
      sub: 'user-1',
      schoolId: null,
      role: 'super_admin',
      isSuperAdmin: true,
    });
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it('round-trips an MFA challenge token', () => {
    const service = buildService();
    const token = service.signMfaChallenge('user-1');
    expect(service.verifyMfaChallenge(token)).toEqual({ userId: 'user-1' });
  });

  it('rejects an access token presented as an MFA challenge token', () => {
    const service = buildService();
    const accessToken = service.signAccessToken({
      sub: 'user-1',
      schoolId: null,
      role: 'super_admin',
      isSuperAdmin: true,
    });
    expect(() => service.verifyMfaChallenge(accessToken)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- token.service`
Expected: FAIL — `Cannot find module './token.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/auth/token.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Env } from '../config/env.schema';
import { UserRole } from '../entities/user.entity';

export interface AccessTokenClaims {
  sub: string;
  schoolId: string | null;
  role: UserRole;
  isSuperAdmin: boolean;
}

interface MfaChallengeClaims {
  sub: string;
  purpose: 'mfa-challenge';
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwtService.sign(claims, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: this.configService.get('ACCESS_TOKEN_TTL_SECONDS'),
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwtService.verify<AccessTokenClaims>(token, {
      secret: this.configService.get('JWT_SECRET'),
    });
  }

  signMfaChallenge(userId: string): string {
    const claims: MfaChallengeClaims = { sub: userId, purpose: 'mfa-challenge' };
    return this.jwtService.sign(claims, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: this.configService.get('MFA_CHALLENGE_TTL_SECONDS'),
    });
  }

  verifyMfaChallenge(token: string): { userId: string } {
    const claims = this.jwtService.verify<MfaChallengeClaims>(token, {
      secret: this.configService.get('JWT_SECRET'),
    });
    if (claims.purpose !== 'mfa-challenge') {
      throw new Error('Not an MFA challenge token');
    }
    return { userId: claims.sub };
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- token.service`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/token.service.ts apps/api/src/auth/token.service.spec.ts
git commit -m "feat: add JWT access-token and MFA-challenge-token service"
```

---

### Task 11: Tenancy context — `AsyncLocalStorage`, `TenantContextService`, `TenancyInterceptor`

**Files:**
- Create: `apps/api/src/tenancy/tenant-context.ts`, `apps/api/src/tenancy/tenant-context.service.ts`, `apps/api/src/tenancy/tenancy.interceptor.ts`, `apps/api/src/tenancy/tenancy.module.ts`
- Test: `apps/api/src/tenancy/tenant-context.service.spec.ts`, `apps/api/src/tenancy/tenancy.interceptor.spec.ts`

**Interfaces:**
- Consumes: `appDataSourceOptions` (Task 3), `AccessTokenClaims` (Task 10).
- Produces: `TenantContextService` with `runWithTenant<T>(claims: AccessTokenClaims | null, work: (manager: EntityManager) => Promise<T>): Promise<T>` and `getManager(): EntityManager` (throws outside a `runWithTenant` call — this is the guardrail that stops a handler from accidentally using the unscoped global connection). `TenancyInterceptor implements NestInterceptor`, applied globally in `app.module.ts` (Task 17), which extracts `AccessTokenClaims` off `request.user` (set by `JwtAuthGuard`, Task 14) and wraps the route handler in `runWithTenant`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/tenancy/tenant-context.service.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { TenantContextService } from './tenant-context.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('TenantContextService', () => {
  let dataSource: DataSource;
  let service: TenantContextService;
  let schoolA: string;
  let schoolB: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    service = new TenantContextService(dataSource);

    await service.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const a = await manager.query(`INSERT INTO core.schools (name) VALUES ('A') RETURNING id`);
        const b = await manager.query(`INSERT INTO core.schools (name) VALUES ('B') RETURNING id`);
        schoolA = a[0].id;
        schoolB = b[0].id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('scopes queries to the given school for the duration of the callback', async () => {
    const rows = await service.runWithTenant(
      { sub: 'u1', schoolId: schoolA, role: 'school_admin', isSuperAdmin: false },
      (manager) => manager.query(`SELECT id FROM core.schools`),
    );
    expect(rows).toEqual([{ id: schoolA }]);
  });

  it('gives a super_admin visibility of every school', async () => {
    const rows = await service.runWithTenant(
      { sub: 'u2', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.query(`SELECT id FROM core.schools ORDER BY id`),
    );
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([schoolA, schoolB].sort());
  });

  it('runs an unauthenticated context (claims=null) with no tenant visibility', async () => {
    const rows = await service.runWithTenant(null, (manager) =>
      manager.query(`SELECT id FROM core.schools`),
    );
    expect(rows).toEqual([]);
  });

  it('throws if getManager() is called outside runWithTenant', () => {
    expect(() => service.getManager()).toThrow(/runWithTenant/);
  });

  it('rolls back the transaction when the callback throws', async () => {
    await expect(
      service.runWithTenant(
        { sub: 'u1', schoolId: schoolA, role: 'school_admin', isSuperAdmin: false },
        async (manager) => {
          await manager.query(`INSERT INTO core.schools (id, name) VALUES ('${schoolA}', 'dup')`);
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    const rows = await service.runWithTenant(
      { sub: 'u2', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.query(`SELECT count(*)::int AS count FROM core.schools WHERE name = 'dup'`),
    );
    expect(rows[0].count).toBe(0);
  });

  it('isolates concurrent calls from each other (AsyncLocalStorage does not leak)', async () => {
    const [resultA, resultB] = await Promise.all([
      service.runWithTenant(
        { sub: 'u1', schoolId: schoolA, role: 'school_admin', isSuperAdmin: false },
        (manager) => manager.query(`SELECT id FROM core.schools`),
      ),
      service.runWithTenant(
        { sub: 'u3', schoolId: schoolB, role: 'school_admin', isSuperAdmin: false },
        (manager) => manager.query(`SELECT id FROM core.schools`),
      ),
    ]);
    expect(resultA).toEqual([{ id: schoolA }]);
    expect(resultB).toEqual([{ id: schoolB }]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @transitos/api test -- tenant-context.service`
Expected: FAIL — `Cannot find module './tenant-context.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/tenancy/tenant-context.ts`:
```ts
import { AsyncLocalStorage } from 'async_hooks';
import { EntityManager } from 'typeorm';

export const tenantContextStorage = new AsyncLocalStorage<EntityManager>();
```

`apps/api/src/tenancy/tenant-context.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessTokenClaims } from '../auth/token.service';
import { tenantContextStorage } from './tenant-context';

@Injectable()
export class TenantContextService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Runs `work` inside a transaction whose session variables reflect `claims`.
   * `claims === null` runs with no tenant/super-admin context at all — every RLS
   * policy that isn't the login carve-out or audit-log insert then sees nothing.
   */
  async runWithTenant<T>(
    claims: AccessTokenClaims | null,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `SET LOCAL app.is_super_admin = '${claims?.isSuperAdmin ? 'true' : 'false'}'`,
      );
      await queryRunner.query(
        `SET LOCAL app.current_school_id = '${claims?.schoolId ?? ''}'`,
      );

      const result = await tenantContextStorage.run(queryRunner.manager, () =>
        work(queryRunner.manager),
      );

      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  getManager(): EntityManager {
    const manager = tenantContextStorage.getStore();
    if (!manager) {
      throw new Error(
        'TenantContextService.getManager() called outside runWithTenant() — ' +
          'every query must run inside a tenant-scoped transaction.',
      );
    }
    return manager;
  }
}
```

Note: `claims.schoolId` and `.isSuperAdmin` never come from request input at this
layer — they're only ever produced by `TokenService.verifyAccessToken`, so string
interpolation here carries values this service already trusts as a verified JWT's
claims, not attacker-controlled input. `schoolId` is a UUID produced by Postgres
(`gen_random_uuid()`) and round-tripped through a signed JWT; `isSuperAdmin` is a
boolean. Sub-project 2, when it adds any endpoint that lets a *user* influence what
gets set here, must not repeat this pattern for user-controlled values — use a bound
parameter or a validated allowlist instead.

- [ ] **Step 4: Write the interceptor and its test**

`apps/api/src/tenancy/tenancy.interceptor.spec.ts`:
```ts
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { TenancyInterceptor } from './tenancy.interceptor';
import { TenantContextService } from './tenant-context.service';

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenancyInterceptor', () => {
  it('runs the handler inside runWithTenant using request.user as claims', async () => {
    const runWithTenant = jest.fn((_claims, work) => work({} as never));
    const tenantContextService = { runWithTenant } as unknown as TenantContextService;
    const interceptor = new TenancyInterceptor(tenantContextService);

    const claims = { sub: 'u1', schoolId: 's1', role: 'school_admin', isSuperAdmin: false };
    const handler: CallHandler = { handle: () => of('result') };

    const result = await interceptor.intercept(buildContext(claims), handler).toPromise();

    expect(result).toBe('result');
    expect(runWithTenant).toHaveBeenCalledWith(claims, expect.any(Function));
  });

  it('passes null claims through for an unauthenticated (public) route', async () => {
    const runWithTenant = jest.fn((_claims, work) => work({} as never));
    const tenantContextService = { runWithTenant } as unknown as TenantContextService;
    const interceptor = new TenancyInterceptor(tenantContextService);
    const handler: CallHandler = { handle: () => of('result') };

    await interceptor.intercept(buildContext(undefined), handler).toPromise();

    expect(runWithTenant).toHaveBeenCalledWith(null, expect.any(Function));
  });
});
```

`apps/api/src/tenancy/tenancy.interceptor.ts`:
```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { AccessTokenClaims } from '../auth/token.service';
import { TenantContextService } from './tenant-context.service';

@Injectable()
export class TenancyInterceptor implements NestInterceptor {
  constructor(private readonly tenantContextService: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ user?: AccessTokenClaims }>();
    const claims = request.user ?? null;

    return from(
      this.tenantContextService.runWithTenant(claims, () => next.handle().toPromise()),
    );
  }
}
```

`apps/api/src/tenancy/tenancy.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { appDataSourceOptions } from '../database/data-source';
import { TenantContextService } from './tenant-context.service';
import { TenancyInterceptor } from './tenancy.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: async () => new DataSource(appDataSourceOptions).initialize(),
    },
    TenantContextService,
    TenancyInterceptor,
  ],
  exports: [TenantContextService, TenancyInterceptor],
})
export class TenancyModule {}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @transitos/api test -- tenancy`
Expected: PASS, 8 tests total (6 + 2).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tenancy
git commit -m "feat: add AsyncLocalStorage tenant context and tenancy interceptor"
```

---

### Task 12: Refresh-token lifecycle — issue, rotate, revoke, revoke-all

**Files:**
- Create: `apps/api/src/auth/refresh-token.service.ts`
- Test: `apps/api/src/auth/refresh-token.service.spec.ts`

**Interfaces:**
- Consumes: `TenantContextService.getManager()` (Task 11), `RefreshToken` entity (Task 6), `Env.REFRESH_TOKEN_TTL_SECONDS` (Task 2).
- Produces: `RefreshTokenService` with `issue(userId: string, deviceInfo: string | null): Promise<{ rawToken: string; fingerprint: string }>`, `rotate(rawToken: string, deviceInfo: string | null): Promise<{ rawToken: string; fingerprint: string; userId: string }>` (throws on invalid/expired/revoked/fingerprint-mismatch), `revoke(rawToken: string): Promise<void>`, `revokeAllForUser(userId: string): Promise<void>`. `fingerprint(deviceInfo: string | null): string` is exported for reuse by tests and by `AuthService`.

Every method calls `tenantContextService.getManager()` internally — callers must already be inside a `runWithTenant` context. Since `core.refresh_tokens` carries no RLS, this holds regardless of which tenant context (including `null`, pre-authentication) is active; the caller is `AuthService`, which always runs inside the interceptor's context.

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/refresh-token.service.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { RefreshTokenService, fingerprint } from './refresh-token.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('RefreshTokenService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: RefreshTokenService;
  let userId: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new RefreshTokenService(tenantContextService, {
      get: () => 604800,
    } as never);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [user] = await manager.query(
          `INSERT INTO core.users (role, email, password_hash, display_name)
           VALUES ('super_admin', 'refresh-test@example.com', 'hash', 'Root') RETURNING id`,
        );
        userId = user.id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const runNull = <T>(work: () => Promise<T>) => tenantContextService.runWithTenant(null, work);

  it('issues a token that rotate() accepts with a matching device', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    const rotated = await runNull(() => service.rotate(rawToken, 'device-A'));
    expect(rotated.userId).toBe(userId);
    expect(rotated.rawToken).not.toBe(rawToken);
  });

  it('rejects rotate() with a mismatched device fingerprint', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    await expect(runNull(() => service.rotate(rawToken, 'device-B'))).rejects.toThrow();
  });

  it('rejects rotate() after the token has already been rotated once', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    await runNull(() => service.rotate(rawToken, 'device-A'));
    await expect(runNull(() => service.rotate(rawToken, 'device-A'))).rejects.toThrow();
  });

  it('rejects rotate() after revoke()', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    await runNull(() => service.revoke(rawToken));
    await expect(runNull(() => service.rotate(rawToken, 'device-A'))).rejects.toThrow();
  });

  it('revokeAllForUser() invalidates every session for that user', async () => {
    const first = await runNull(() => service.issue(userId, 'device-A'));
    const second = await runNull(() => service.issue(userId, 'device-B'));
    await runNull(() => service.revokeAllForUser(userId));

    await expect(runNull(() => service.rotate(first.rawToken, 'device-A'))).rejects.toThrow();
    await expect(runNull(() => service.rotate(second.rawToken, 'device-B'))).rejects.toThrow();
  });

  it('fingerprint() is deterministic for the same device info', () => {
    expect(fingerprint('device-A')).toBe(fingerprint('device-A'));
    expect(fingerprint('device-A')).not.toBe(fingerprint('device-B'));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- refresh-token.service`
Expected: FAIL — `Cannot find module './refresh-token.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/auth/refresh-token.service.ts`:
```ts
import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { RefreshToken } from '../entities/refresh-token.entity';

export function fingerprint(deviceInfo: string | null): string {
  return createHash('sha256').update(deviceInfo ?? 'unknown-device').digest('hex');
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async issue(
    userId: string,
    deviceInfo: string | null,
  ): Promise<{ rawToken: string; fingerprint: string }> {
    const rawToken = randomBytes(32).toString('hex');
    const ttlSeconds = this.configService.get('REFRESH_TOKEN_TTL_SECONDS');
    const manager = this.tenantContextService.getManager();

    await manager.getRepository(RefreshToken).insert({
      userId,
      tokenHash: hashToken(rawToken),
      deviceFingerprint: fingerprint(deviceInfo),
      deviceInfo,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });

    return { rawToken, fingerprint: fingerprint(deviceInfo) };
  }

  async rotate(
    rawToken: string,
    deviceInfo: string | null,
  ): Promise<{ rawToken: string; fingerprint: string; userId: string }> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(RefreshToken);
    const row = await repo.findOne({ where: { tokenHash: hashToken(rawToken) } });

    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new Error('Refresh token is invalid, expired, or revoked');
    }
    if (row.deviceFingerprint !== fingerprint(deviceInfo)) {
      throw new Error('Refresh token device fingerprint mismatch');
    }

    await repo.update(row.id, { revokedAt: new Date() });
    const next = await this.issue(row.userId, deviceInfo);
    return { ...next, userId: row.userId };
  }

  async revoke(rawToken: string): Promise<void> {
    const manager = this.tenantContextService.getManager();
    await manager
      .getRepository(RefreshToken)
      .update({ tokenHash: hashToken(rawToken) }, { revokedAt: new Date() });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const manager = this.tenantContextService.getManager();
    await manager
      .getRepository(RefreshToken)
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- refresh-token.service`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/refresh-token.service.ts apps/api/src/auth/refresh-token.service.spec.ts
git commit -m "feat: add refresh-token issue/rotate/revoke lifecycle with device binding"
```

---

### Task 13: MFA service — TOTP enrollment and verification

**Files:**
- Create: `apps/api/src/auth/mfa.service.ts`
- Test: `apps/api/src/auth/mfa.service.spec.ts`

**Interfaces:**
- Consumes: `otplib`, `qrcode`, `encryptSecret`/`decryptSecret` (Task 8), `TenantContextService.getManager()` (Task 11), `MfaCredential` entity (Task 6), `Env.MFA_ENCRYPTION_KEY` (Task 2).
- Produces: `MfaService` with `beginEnrollment(userId: string, accountLabel: string): Promise<{ secret: string; qrCodeDataUrl: string }>` (upserts a row with `enabled_at = null`), `confirmEnrollment(userId: string, totpCode: string): Promise<void>` (sets `enabled_at`, throws on a bad code or missing enrollment), `isEnabled(userId: string): Promise<boolean>`, `verifyCode(userId: string, totpCode: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/mfa.service.spec.ts`:
```ts
import { authenticator } from 'otplib';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { MfaService } from './mfa.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

const MFA_ENCRYPTION_KEY = '0'.repeat(64);

describe('MfaService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: MfaService;
  let userId: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new MfaService(tenantContextService, {
      get: () => MFA_ENCRYPTION_KEY,
    } as never);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [user] = await manager.query(
          `INSERT INTO core.users (role, email, password_hash, display_name)
           VALUES ('super_admin', 'mfa-test@example.com', 'hash', 'Root') RETURNING id`,
        );
        userId = user.id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const runNull = <T>(work: () => Promise<T>) => tenantContextService.runWithTenant(null, work);

  it('reports MFA disabled before enrollment', async () => {
    expect(await runNull(() => service.isEnabled(userId))).toBe(false);
  });

  it('completes enrollment with a valid TOTP code and enables MFA', async () => {
    const { secret } = await runNull(() => service.beginEnrollment(userId, 'mfa-test@example.com'));
    const code = authenticator.generate(secret);

    await runNull(() => service.confirmEnrollment(userId, code));

    expect(await runNull(() => service.isEnabled(userId))).toBe(true);
  });

  it('rejects confirmEnrollment with an invalid code', async () => {
    await runNull(() => service.beginEnrollment(userId, 'mfa-test-2@example.com'));
    await expect(runNull(() => service.confirmEnrollment(userId, '000000'))).rejects.toThrow();
  });

  it('verifies a correct code once enabled', async () => {
    const { secret } = await runNull(() =>
      service.beginEnrollment(userId, 'mfa-test-3@example.com'),
    );
    const code = authenticator.generate(secret);
    await runNull(() => service.confirmEnrollment(userId, code));

    const nextCode = authenticator.generate(secret);
    expect(await runNull(() => service.verifyCode(userId, nextCode))).toBe(true);
  });

  it('rejects an incorrect code once enabled', async () => {
    const { secret } = await runNull(() =>
      service.beginEnrollment(userId, 'mfa-test-4@example.com'),
    );
    const code = authenticator.generate(secret);
    await runNull(() => service.confirmEnrollment(userId, code));

    expect(await runNull(() => service.verifyCode(userId, '000000'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- mfa.service`
Expected: FAIL — `Cannot find module './mfa.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/auth/mfa.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { Env } from '../config/env.schema';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { MfaCredential } from '../entities/mfa-credential.entity';
import { encryptSecret, decryptSecret } from '../crypto/secret-box';

const ISSUER = 'TransitOS';

@Injectable()
export class MfaService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async beginEnrollment(
    userId: string,
    accountLabel: string,
  ): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(MfaCredential);
    const encrypted = encryptSecret(secret, this.configService.get('MFA_ENCRYPTION_KEY'));

    const existing = await repo.findOne({ where: { userId } });
    if (existing) {
      await repo.update(existing.id, { secretEncrypted: encrypted, enabledAt: null });
    } else {
      await repo.insert({ userId, secretEncrypted: encrypted, enabledAt: null });
    }

    return { secret, qrCodeDataUrl };
  }

  async confirmEnrollment(userId: string, totpCode: string): Promise<void> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(MfaCredential);
    const row = await repo.findOne({ where: { userId } });
    if (!row) {
      throw new Error('No MFA enrollment in progress for this user');
    }

    const secret = decryptSecret(row.secretEncrypted, this.configService.get('MFA_ENCRYPTION_KEY'));
    if (!authenticator.check(totpCode, secret)) {
      throw new Error('Invalid TOTP code');
    }

    await repo.update(row.id, { enabledAt: new Date() });
  }

  async isEnabled(userId: string): Promise<boolean> {
    const manager = this.tenantContextService.getManager();
    const row = await manager.getRepository(MfaCredential).findOne({ where: { userId } });
    return Boolean(row?.enabledAt);
  }

  async verifyCode(userId: string, totpCode: string): Promise<boolean> {
    const manager = this.tenantContextService.getManager();
    const row = await manager.getRepository(MfaCredential).findOne({ where: { userId } });
    if (!row?.enabledAt) {
      return false;
    }
    const secret = decryptSecret(row.secretEncrypted, this.configService.get('MFA_ENCRYPTION_KEY'));
    return authenticator.check(totpCode, secret);
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- mfa.service`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/mfa.service.ts apps/api/src/auth/mfa.service.spec.ts
git commit -m "feat: add TOTP MFA enrollment and verification service"
```

---

### Task 14: Audit service — the append-only writer every privileged action calls

**Files:**
- Create: `apps/api/src/audit/audit.service.ts`, `apps/api/src/audit/audit.module.ts`
- Test: `apps/api/src/audit/audit.service.spec.ts`

**Interfaces:**
- Consumes: `TenantContextService.getManager()` (Task 11), `AuditLog` entity (Task 7).
- Produces: `AuditService` with `record(entry: { schoolId: string | null; actorUserId: string | null; action: string; entityType?: string; entityId?: string; ipAddress?: string; metadata?: Record<string, unknown> }): Promise<void>`, and `AuditModule` (exports `AuditService`). Both are needed by `AuthModule` in Task 16, so `AuditModule` is created here rather than alongside the other `common/` wiring in Task 17 — creating it later would make Task 16's `auth.module.ts` reference a file that doesn't exist yet.

- [ ] **Step 1: Write the failing test**

`apps/api/src/audit/audit.service.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditService } from './audit.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('AuditService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: AuditService;
  let schoolId: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new AuditService(tenantContextService);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [school] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('Audit Test School') RETURNING id`,
        );
        schoolId = school.id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('writes a record visible to that school afterward', async () => {
    await tenantContextService.runWithTenant(null, () =>
      service.record({
        schoolId,
        actorUserId: null,
        action: 'user.login',
        metadata: { via: 'password' },
      }),
    );

    const rows = await tenantContextService.runWithTenant(
      { sub: 'admin', schoolId, role: 'school_admin', isSuperAdmin: false },
      (manager) => manager.query(`SELECT action, metadata FROM audit.audit_logs WHERE school_id = '${schoolId}'`),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.login');
    expect(rows[0].metadata).toEqual({ via: 'password' });
  });

  it('accepts a null schoolId for platform-level actions', async () => {
    await tenantContextService.runWithTenant(null, () =>
      service.record({ schoolId: null, actorUserId: null, action: 'school.created' }),
    );

    const rows = await tenantContextService.runWithTenant(
      { sub: 'root', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) =>
        manager.query(`SELECT action FROM audit.audit_logs WHERE school_id IS NULL AND action = 'school.created'`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- audit.service`
Expected: FAIL — `Cannot find module './audit.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/audit/audit.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditLog } from '../entities/audit-log.entity';

export interface AuditEntry {
  schoolId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly tenantContextService: TenantContextService) {}

  async record(entry: AuditEntry): Promise<void> {
    const manager = this.tenantContextService.getManager();
    await manager.getRepository(AuditLog).insert({
      schoolId: entry.schoolId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ipAddress: entry.ipAddress ?? null,
      metadata: entry.metadata ?? {},
    });
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- audit.service`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the module**

`apps/api/src/audit/audit.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/audit
git commit -m "feat: add append-only audit service"
```

---

### Task 15: Guards and decorators — `JwtAuthGuard`, `RolesGuard`, `@Roles`, `@Public`, `@CurrentUser`

**Files:**
- Create: `apps/api/src/auth/decorators/public.decorator.ts`, `apps/api/src/auth/decorators/roles.decorator.ts`, `apps/api/src/auth/decorators/current-user.decorator.ts`
- Create: `apps/api/src/auth/guards/jwt-auth.guard.ts`, `apps/api/src/auth/guards/roles.guard.ts`
- Test: `apps/api/src/auth/guards/jwt-auth.guard.spec.ts`, `apps/api/src/auth/guards/roles.guard.spec.ts`

**Interfaces:**
- Consumes: `TokenService.verifyAccessToken` (Task 10).
- Produces: `@Public()` (marks a route as not requiring auth), `@Roles(...roles: UserRole[])`, `@CurrentUser()` (param decorator extracting `AccessTokenClaims` from `request.user`), `JwtAuthGuard` (sets `request.user`, skips for `@Public()` routes), `RolesGuard` (403s unless `request.user.role` is in the route's `@Roles()` list, or the route has none).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/auth/guards/jwt-auth.guard.spec.ts`:
```ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from '../token.service';

function buildContext(authHeader?: string): ExecutionContext {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authHeader ? { authorization: authHeader } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('allows a route marked @Public() through without a token', () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector, {} as TokenService);
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it('rejects a protected route with no Authorization header', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector, {} as TokenService);
    expect(() => guard.canActivate(buildContext())).toThrow(UnauthorizedException);
  });

  it('rejects a protected route with an invalid token', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const tokenService = {
      verifyAccessToken: () => {
        throw new Error('bad token');
      },
    } as unknown as TokenService;
    const guard = new JwtAuthGuard(reflector, tokenService);
    expect(() => guard.canActivate(buildContext('Bearer bad-token'))).toThrow(UnauthorizedException);
  });

  it('attaches claims to request.user on a valid token', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const claims = { sub: 'u1', schoolId: 's1', role: 'school_admin', isSuperAdmin: false };
    const tokenService = { verifyAccessToken: () => claims } as unknown as TokenService;
    const guard = new JwtAuthGuard(reflector, tokenService);
    const context = buildContext('Bearer good-token');

    expect(guard.canActivate(context)).toBe(true);
    expect(context.switchToHttp().getRequest().user).toEqual(claims);
  });
});
```

`apps/api/src/auth/guards/roles.guard.spec.ts`:
```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function buildContext(role: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows any authenticated user when the route declares no @Roles()', () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(buildContext('parent'))).toBe(true);
  });

  it('allows a user whose role is in the required list', () => {
    const reflector = { getAllAndOverride: () => ['super_admin', 'school_admin'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(buildContext('school_admin'))).toBe(true);
  });

  it('rejects a user whose role is not in the required list', () => {
    const reflector = { getAllAndOverride: () => ['super_admin'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(buildContext('parent'))).toThrow(ForbiddenException);
  });

  it('rejects when there is no authenticated user at all', () => {
    const reflector = { getAllAndOverride: () => ['super_admin'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @transitos/api test -- guards`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the decorators**

`apps/api/src/auth/decorators/public.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);
```

`apps/api/src/auth/decorators/roles.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../entities/user.entity';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(ROLES_KEY, roles);
```

`apps/api/src/auth/decorators/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AccessTokenClaims } from '../token.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims =>
    ctx.switchToHttp().getRequest<{ user: AccessTokenClaims }>().user,
);
```

- [ ] **Step 4: Implement the guards**

`apps/api/src/auth/guards/jwt-auth.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AccessTokenClaims, TokenService } from '../token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: AccessTokenClaims }>();
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      request.user = this.tokenService.verifyAccessToken(authHeader.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    return true;
  }
}
```

`apps/api/src/auth/guards/roles.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AccessTokenClaims } from '../token.service';
import { UserRole } from '../../entities/user.entity';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<{ user?: AccessTokenClaims }>().user;
    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @transitos/api test -- guards`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/decorators apps/api/src/auth/guards
git commit -m "feat: add JwtAuthGuard, RolesGuard, and their decorators"
```

---

### Task 16: `AuthService` orchestration and `AuthController` — login, MFA, refresh, logout

**Files:**
- Create: `apps/api/src/auth/dto/login.dto.ts`, `apps/api/src/auth/dto/mfa-verify.dto.ts`, `apps/api/src/auth/dto/mfa-confirm.dto.ts`, `apps/api/src/auth/dto/refresh.dto.ts`, `apps/api/src/auth/dto/logout.dto.ts`
- Create: `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.module.ts`
- Test: `apps/api/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `PasswordService` (9), `TokenService` (10), `RefreshTokenService` (12), `MfaService` (13), `AuditService` (14), `TenantContextService.getManager()` (11), `User` entity (5), `MFA_ELIGIBLE_ROLES` (5).
- Produces: `AuthService` with `login(input, deviceInfo, ip): Promise<LoginResult>`, `completeMfaChallenge(mfaChallengeToken, totpCode, deviceInfo, ip): Promise<TokenPair>`, `refresh(rawToken, deviceInfo): Promise<TokenPair>`, `logout(rawToken, actorUserId): Promise<void>`, `logoutAll(userId): Promise<void>`, where `type LoginResult = { mfaRequired: true; mfaChallengeToken: string } | ({ mfaRequired: false } & TokenPair)` and `type TokenPair = { accessToken: string; refreshToken: string }`. `AuthController` exposes the six routes from the spec's §5, each behind `@Throttle` limits.

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/auth.service.spec.ts`:
```ts
import { authenticator } from 'otplib';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';
import { Env } from '../config/env.schema';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://a:b@localhost/db',
  DATABASE_MIGRATION_URL: 'postgres://a:b@localhost/db',
  APP_DB_ROLE: 'transitos_app',
  APP_DB_PASSWORD: 'x',
  JWT_SECRET: 'a'.repeat(32),
  MFA_ENCRYPTION_KEY: '0'.repeat(64),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 604800,
  MFA_CHALLENGE_TTL_SECONDS: 300,
};
const configService = { get: (key: keyof Env) => testEnv[key] } as never;

describe('AuthService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let refreshTokenService: RefreshTokenService;
  let mfaService: MfaService;
  let auditService: AuditService;
  let authService: AuthService;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    passwordService = new PasswordService();
    tokenService = new TokenService(new JwtService(), configService);
    refreshTokenService = new RefreshTokenService(tenantContextService, configService);
    mfaService = new MfaService(tenantContextService, configService);
    auditService = new AuditService(tenantContextService);
    authService = new AuthService(
      tenantContextService,
      passwordService,
      tokenService,
      refreshTokenService,
      mfaService,
      auditService,
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function createUser(email: string, role: string, password: string): Promise<string> {
    return tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const hash = await passwordService.hash(password);
        const [user] = await manager.query(
          `INSERT INTO core.users (role, email, password_hash, display_name)
           VALUES ('${role}', '${email}', '${hash}', 'Test User') RETURNING id`,
        );
        return user.id;
      },
    );
  }

  it('logs in a driver (no MFA) directly with tokens', async () => {
    await createUser('driver-a@example.com', 'driver', 'Correct-Horse9!');

    const result = await tenantContextService.runWithTenant(null, () =>
      authService.login(
        { emailOrPhone: 'driver-a@example.com', password: 'Correct-Horse9!' },
        'device-A',
        '127.0.0.1',
      ),
    );

    expect(result.mfaRequired).toBe(false);
    if (!result.mfaRequired) {
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
    }
  });

  it('rejects a wrong password', async () => {
    await createUser('driver-b@example.com', 'driver', 'Correct-Horse9!');

    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.login(
          { emailOrPhone: 'driver-b@example.com', password: 'Wrong-Password9!' },
          'device-A',
          '127.0.0.1',
        ),
      ),
    ).rejects.toThrow();
  });

  it('returns an MFA challenge for a school_admin with MFA enabled, then completes it', async () => {
    const userId = await createUser('admin-mfa@example.com', 'school_admin', 'Correct-Horse9!');
    const { secret } = await tenantContextService.runWithTenant(null, () =>
      mfaService.beginEnrollment(userId, 'admin-mfa@example.com'),
    );
    await tenantContextService.runWithTenant(null, () =>
      mfaService.confirmEnrollment(userId, authenticator.generate(secret)),
    );

    const loginResult = await tenantContextService.runWithTenant(null, () =>
      authService.login(
        { emailOrPhone: 'admin-mfa@example.com', password: 'Correct-Horse9!' },
        'device-A',
        '127.0.0.1',
      ),
    );
    expect(loginResult.mfaRequired).toBe(true);

    if (loginResult.mfaRequired) {
      const tokens = await tenantContextService.runWithTenant(null, () =>
        authService.completeMfaChallenge(
          loginResult.mfaChallengeToken,
          authenticator.generate(secret),
          'device-A',
          '127.0.0.1',
        ),
      );
      expect(tokens.accessToken).toEqual(expect.any(String));
    }
  });

  it('rejects a school_admin with MFA enabled logging in without a challenge bypass', async () => {
    const userId = await createUser('admin-mfa-2@example.com', 'school_admin', 'Correct-Horse9!');
    const { secret } = await tenantContextService.runWithTenant(null, () =>
      mfaService.beginEnrollment(userId, 'admin-mfa-2@example.com'),
    );
    await tenantContextService.runWithTenant(null, () =>
      mfaService.confirmEnrollment(userId, authenticator.generate(secret)),
    );

    const loginResult = await tenantContextService.runWithTenant(null, () =>
      authService.login(
        { emailOrPhone: 'admin-mfa-2@example.com', password: 'Correct-Horse9!' },
        'device-A',
        '127.0.0.1',
      ),
    );

    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.completeMfaChallenge(
          loginResult.mfaRequired ? loginResult.mfaChallengeToken : '',
          '000000',
          'device-A',
          '127.0.0.1',
        ),
      ),
    ).rejects.toThrow();
  });

  it('full lifecycle: login, refresh, logout, then refresh fails', async () => {
    await createUser('lifecycle@example.com', 'parent', 'Correct-Horse9!');

    const login = await tenantContextService.runWithTenant(null, () =>
      authService.login(
        { emailOrPhone: 'lifecycle@example.com', password: 'Correct-Horse9!' },
        'device-A',
        '127.0.0.1',
      ),
    );
    if (login.mfaRequired) throw new Error('unexpected mfa challenge');

    const refreshed = await tenantContextService.runWithTenant(null, () =>
      authService.refresh(login.refreshToken, 'device-A'),
    );

    await tenantContextService.runWithTenant(null, () =>
      authService.logout(refreshed.refreshToken, undefined),
    );

    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.refresh(refreshed.refreshToken, 'device-A'),
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- auth.service`
Expected: FAIL — `Cannot find module './auth.service'`.

- [ ] **Step 3: Implement the DTOs**

`apps/api/src/auth/dto/login.dto.ts`:
```ts
import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  emailOrPhone: string;

  @IsString()
  @MinLength(1)
  password: string;
}
```

`apps/api/src/auth/dto/mfa-verify.dto.ts`:
```ts
import { IsString, Length } from 'class-validator';

export class MfaVerifyDto {
  @IsString()
  mfaChallengeToken: string;

  @IsString()
  @Length(6, 6)
  totpCode: string;
}
```

`apps/api/src/auth/dto/mfa-confirm.dto.ts`:
```ts
import { IsString, Length } from 'class-validator';

export class MfaConfirmDto {
  @IsString()
  @Length(6, 6)
  totpCode: string;
}
```

`apps/api/src/auth/dto/refresh.dto.ts`:
```ts
import { IsString } from 'class-validator';

export class RefreshDto {
  @IsString()
  refreshToken: string;
}
```

`apps/api/src/auth/dto/logout.dto.ts`:
```ts
import { IsString } from 'class-validator';

export class LogoutDto {
  @IsString()
  refreshToken: string;
}
```

- [ ] **Step 4: Implement `AuthService`**

`apps/api/src/auth/auth.service.ts`:
```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { AuditService } from '../audit/audit.service';
import { User, MFA_ELIGIBLE_ROLES } from '../entities/user.entity';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type LoginResult = { mfaRequired: true; mfaChallengeToken: string } | ({ mfaRequired: false } & TokenPair);

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly mfaService: MfaService,
    private readonly auditService: AuditService,
  ) {}

  async login(
    input: { emailOrPhone: string; password: string },
    deviceInfo: string | null,
    ipAddress: string,
  ): Promise<LoginResult> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(User);

    // The login carve-out RLS policy (see the CreateUsers migration) requires this
    // exact SET LOCAL, scoped to the connection this query runs on.
    await manager.query(`SET LOCAL app.auth_lookup = 'true'`);
    const user = await repo
      .createQueryBuilder('u')
      .where('u.email = :value OR u.phone = :value', { value: input.emailOrPhone })
      .getOne();

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const passwordOk = await this.passwordService.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (MFA_ELIGIBLE_ROLES.includes(user.role) && (await this.mfaService.isEnabled(user.id))) {
      return { mfaRequired: true, mfaChallengeToken: this.tokenService.signMfaChallenge(user.id) };
    }

    return { mfaRequired: false, ...(await this.issueSession(user, deviceInfo, ipAddress)) };
  }

  async completeMfaChallenge(
    mfaChallengeToken: string,
    totpCode: string,
    deviceInfo: string | null,
    ipAddress: string,
  ): Promise<TokenPair> {
    const { userId } = this.tokenService.verifyMfaChallenge(mfaChallengeToken);

    const codeOk = await this.mfaService.verifyCode(userId, totpCode);
    if (!codeOk) {
      throw new UnauthorizedException('Invalid MFA code');
    }

    const manager = this.tenantContextService.getManager();
    await manager.query(`SET LOCAL app.auth_lookup = 'true'`);
    const user = await manager.getRepository(User).findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    return this.issueSession(user, deviceInfo, ipAddress);
  }

  async refresh(rawToken: string, deviceInfo: string | null): Promise<TokenPair> {
    const rotated = await this.refreshTokenService.rotate(rawToken, deviceInfo);

    const manager = this.tenantContextService.getManager();
    await manager.query(`SET LOCAL app.auth_lookup = 'true'`);
    const user = await manager.getRepository(User).findOne({ where: { id: rotated.userId } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    return {
      accessToken: this.tokenService.signAccessToken({
        sub: user.id,
        schoolId: user.schoolId,
        role: user.role,
        isSuperAdmin: user.role === 'super_admin',
      }),
      refreshToken: rotated.rawToken,
    };
  }

  async logout(rawToken: string, actorUserId: string | undefined): Promise<void> {
    await this.refreshTokenService.revoke(rawToken);
    await this.auditService.record({
      schoolId: null,
      actorUserId: actorUserId ?? null,
      action: 'user.logout',
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
    await this.auditService.record({
      schoolId: null,
      actorUserId: userId,
      action: 'user.logout_all',
    });
  }

  private async issueSession(
    user: User,
    deviceInfo: string | null,
    ipAddress: string,
  ): Promise<TokenPair> {
    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      schoolId: user.schoolId,
      role: user.role,
      isSuperAdmin: user.role === 'super_admin',
    });
    const { rawToken: refreshToken } = await this.refreshTokenService.issue(user.id, deviceInfo);

    await this.auditService.record({
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: 'user.login',
      ipAddress,
    });

    return { accessToken, refreshToken };
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- auth.service`
Expected: PASS, 6 tests.

- [ ] **Step 6: Implement the controller and module**

`apps/api/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import { AccessTokenClaims } from './token.service';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { LoginDto } from './dto/login.dto';
import { MfaVerifyDto } from './dto/mfa-verify.dto';
import { MfaConfirmDto } from './dto/mfa-confirm.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';

function deviceInfoOf(req: Request): string | null {
  return req.headers['user-agent'] ?? null;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfaService: MfaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, deviceInfoOf(req), req.ip ?? 'unknown');
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  mfaVerify(@Body() dto: MfaVerifyDto, @Req() req: Request) {
    return this.authService.completeMfaChallenge(
      dto.mfaChallengeToken,
      dto.totpCode,
      deviceInfoOf(req),
      req.ip ?? 'unknown',
    );
  }

  @Roles('super_admin', 'school_admin')
  @Post('mfa/setup')
  mfaSetup(@CurrentUser() user: AccessTokenClaims) {
    return this.mfaService.beginEnrollment(user.sub, user.sub);
  }

  @Roles('super_admin', 'school_admin')
  @Post('mfa/confirm')
  mfaConfirm(@CurrentUser() user: AccessTokenClaims, @Body() dto: MfaConfirmDto) {
    return this.mfaService.confirmEnrollment(user.sub, dto.totpCode);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, deviceInfoOf(req));
  }

  @Post('logout')
  logout(@CurrentUser() user: AccessTokenClaims, @Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken, user.sub);
  }

  @Post('logout-all')
  logoutAll(@CurrentUser() user: AccessTokenClaims) {
    return this.authService.logoutAll(user.sub);
  }
}
```

`apps/api/src/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    RefreshTokenService,
    MfaService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth
git commit -m "feat: add AuthService orchestration and AuthController with rate limiting"
```

---

### Task 17: Response envelope interceptor and global exception filter

**Files:**
- Create: `apps/api/src/common/response.interceptor.ts`, `apps/api/src/common/http-exception.filter.ts`
- Test: `apps/api/src/common/response.interceptor.spec.ts`, `apps/api/src/common/http-exception.filter.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure Nest cross-cutting concerns).
- Produces: `ResponseInterceptor implements NestInterceptor` wrapping every successful response as `{ success: true, data }`. `GlobalHttpExceptionFilter implements ExceptionFilter` catching every thrown error and responding `{ success: false, error: { code, message } }`, mapping unknown errors to a generic 500 with no stack trace or raw driver error leaked. Both are wired globally in `AppModule` in Task 20.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/common/response.interceptor.spec.ts`:
```ts
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

describe('ResponseInterceptor', () => {
  it('wraps the handler result in a success envelope', async () => {
    const interceptor = new ResponseInterceptor();
    const handler: CallHandler = { handle: () => of({ id: 'abc' }) };
    const result = await interceptor.intercept({} as ExecutionContext, handler).toPromise();
    expect(result).toEqual({ success: true, data: { id: 'abc' } });
  });
});
```

`apps/api/src/common/http-exception.filter.spec.ts`:
```ts
import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalHttpExceptionFilter } from './http-exception.filter';

function buildHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('GlobalHttpExceptionFilter', () => {
  it('maps a NestJS HttpException to a structured error envelope', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, status, json } = buildHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'bad input' },
    });
  });

  it('maps an unrecognized error to a generic 500 without leaking internals', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, status, json } = buildHost();

    filter.catch(new QueryFailedError('SELECT 1', [], new Error('permission denied for table x')), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @transitos/api test -- common`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/api/src/common/response.interceptor.ts`:
```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<{ success: true; data: unknown }> {
    return next.handle().pipe(map((data) => ({ success: true as const, data })));
  }
}
```

`apps/api/src/common/http-exception.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);

      response.status(status).json({
        success: false,
        error: { code: HttpStatus[status] ?? 'ERROR', message },
      });
      return;
    }

    // Never surface a raw driver/ORM error (e.g. an RLS "permission denied") to the
    // client — log it server-side (left to your logging setup) and return a flat
    // generic message instead.
    response
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @transitos/api test -- common`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common
git commit -m "feat: add response envelope interceptor and global exception filter"
```

---

### Task 18: `UsersModule` — `GET /users/me`

**Files:**
- Create: `apps/api/src/users/users.service.ts`, `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.module.ts`, `apps/api/src/users/dto/user-response.dto.ts`
- Test: `apps/api/src/users/users.service.spec.ts`

**Interfaces:**
- Consumes: `TenantContextService.getManager()` (11), `User` entity (5), `@CurrentUser()` (15).
- Produces: `UsersService.findById(id: string): Promise<User | null>`, `toUserResponse(user: User): UserResponseDto` (the output DTO — deliberately excludes `passwordHash`, matching the "never expose unnecessary fields" rule in `engineering-standards.md` §5). `GET /users/me` returns `UserResponseDto` for the caller.

- [ ] **Step 1: Write the failing test**

`apps/api/src/users/users.service.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { UsersService } from './users.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('UsersService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: UsersService;
  let schoolA: string;
  let userA: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new UsersService(tenantContextService);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [school] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('Users Test School') RETURNING id`,
        );
        schoolA = school.id;
        const [user] = await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ('${schoolA}', 'parent', 'findme@example.com', 'hash', 'Find Me') RETURNING id`,
        );
        userA = user.id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('finds a user within its own tenant scope', async () => {
    const user = await tenantContextService.runWithTenant(
      { sub: userA, schoolId: schoolA, role: 'parent', isSuperAdmin: false },
      () => service.findById(userA),
    );
    expect(user?.email).toBe('findme@example.com');
  });

  it('returns null for a user outside the current tenant scope', async () => {
    const user = await tenantContextService.runWithTenant(
      { sub: 'other', schoolId: '00000000-0000-0000-0000-000000000000', role: 'parent', isSuperAdmin: false },
      () => service.findById(userA),
    );
    expect(user).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- users.service`
Expected: FAIL — `Cannot find module './users.service'`.

- [ ] **Step 3: Implement**

`apps/api/src/users/dto/user-response.dto.ts`:
```ts
import { User, UserRole, UserStatus } from '../../entities/user.entity';

export interface UserResponseDto {
  id: string;
  schoolId: string | null;
  role: UserRole;
  email: string | null;
  phone: string | null;
  displayName: string;
  status: UserStatus;
}

export function toUserResponse(user: User): UserResponseDto {
  return {
    id: user.id,
    schoolId: user.schoolId,
    role: user.role,
    email: user.email,
    phone: user.phone,
    displayName: user.displayName,
    status: user.status,
  };
}
```

`apps/api/src/users/users.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { User } from '../entities/user.entity';

@Injectable()
export class UsersService {
  constructor(private readonly tenantContextService: TenantContextService) {}

  async findById(id: string): Promise<User | null> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(User).findOne({ where: { id } });
  }
}
```

`apps/api/src/users/users.controller.ts`:
```ts
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../auth/token.service';
import { UsersService } from './users.service';
import { toUserResponse, UserResponseDto } from './dto/user-response.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async me(@CurrentUser() claims: AccessTokenClaims): Promise<UserResponseDto> {
    const user = await this.usersService.findById(claims.sub);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toUserResponse(user);
  }
}
```

`apps/api/src/users/users.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- users.service`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/users
git commit -m "feat: add UsersModule with GET /users/me"
```

---

### Task 19: `SchoolsModule` — tenant CRUD and per-school user creation/listing

**Files:**
- Create: `apps/api/src/schools/dto/create-school.dto.ts`, `apps/api/src/schools/dto/create-school-user.dto.ts`, `apps/api/src/schools/dto/school-response.dto.ts`
- Create: `apps/api/src/schools/schools.service.ts`, `apps/api/src/schools/schools.controller.ts`, `apps/api/src/schools/schools.module.ts`
- Test: `apps/api/src/schools/schools.service.spec.ts`

**Interfaces:**
- Consumes: `School` entity (4), `User` entity (5), `PasswordService` (9), `validatePasswordPolicy` (9), `toUserResponse`/`UserResponseDto` (18), `AccessTokenClaims` (10).
- Produces: `SchoolsService` with `create(name: string): Promise<School>`, `findById(id: string): Promise<School | null>`, `findAll(): Promise<School[]>`, `createUser(schoolId: string, input: CreateSchoolUserDto): Promise<User>` (validates the password policy, hashes it, and records it in `password_history`), `listUsers(schoolId: string): Promise<User[]>`.

RLS already prevents a `school_admin` from reading or writing another school's rows (Tasks 4–5); the controller adds the same rule at the application layer — matching the spec's "isolation enforced at two layers" goal — by rejecting a mismatched `:id` with a 403 *before* the query runs, rather than relying solely on the database to turn it into an empty result or a policy violation.

- [ ] **Step 1: Write the failing test**

`apps/api/src/schools/schools.service.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { SchoolsService } from './schools.service';
import { PasswordService } from '../auth/password.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('SchoolsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: SchoolsService;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new SchoolsService(tenantContextService, new PasswordService());
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const asSuperAdmin = <T>(work: () => Promise<T>) =>
    tenantContextService.runWithTenant(
      { sub: 'root', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  it('creates a school and finds it by id', async () => {
    const school = await asSuperAdmin(() => service.create('New School'));
    const found = await asSuperAdmin(() => service.findById(school.id));
    expect(found?.name).toBe('New School');
  });

  it('creates a user under a school with a policy-valid password, hashed', async () => {
    const school = await asSuperAdmin(() => service.create('User Test School'));

    const user = await asSuperAdmin(() =>
      service.createUser(school.id, {
        role: 'school_admin',
        email: 'admin@usertestschool.example.com',
        password: 'Correct-Horse9!',
        displayName: 'The Admin',
      }),
    );

    expect(user.passwordHash).not.toBe('Correct-Horse9!');
    expect(user.schoolId).toBe(school.id);
  });

  it('rejects creating a user with a policy-violating password', async () => {
    const school = await asSuperAdmin(() => service.create('Weak Password School'));

    await expect(
      asSuperAdmin(() =>
        service.createUser(school.id, {
          role: 'parent',
          email: 'weak@weakpasswordschool.example.com',
          password: 'weak',
          displayName: 'Weak Password',
        }),
      ),
    ).rejects.toThrow();
  });

  it('lists only the users belonging to the given school', async () => {
    const schoolA = await asSuperAdmin(() => service.create('List Test A'));
    const schoolB = await asSuperAdmin(() => service.create('List Test B'));
    await asSuperAdmin(() =>
      service.createUser(schoolA.id, {
        role: 'parent',
        email: 'a1@listtest.example.com',
        password: 'Correct-Horse9!',
        displayName: 'A1',
      }),
    );
    await asSuperAdmin(() =>
      service.createUser(schoolB.id, {
        role: 'parent',
        email: 'b1@listtest.example.com',
        password: 'Correct-Horse9!',
        displayName: 'B1',
      }),
    );

    const usersOfA = await asSuperAdmin(() => service.listUsers(schoolA.id));
    expect(usersOfA.map((u) => u.email)).toEqual(['a1@listtest.example.com']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- schools.service`
Expected: FAIL — `Cannot find module './schools.service'`.

- [ ] **Step 3: Implement the DTOs**

`apps/api/src/schools/dto/create-school.dto.ts`:
```ts
import { IsString, MinLength } from 'class-validator';

export class CreateSchoolDto {
  @IsString()
  @MinLength(2)
  name: string;
}
```

`apps/api/src/schools/dto/create-school-user.dto.ts`:
```ts
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '../../entities/user.entity';

const ASSIGNABLE_ROLES: UserRole[] = ['school_admin', 'driver', 'attendant', 'parent'];

export class CreateSchoolUserDto {
  @IsIn(ASSIGNABLE_ROLES)
  role: Exclude<UserRole, 'super_admin'>;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @MinLength(12)
  password: string;

  @IsString()
  @MinLength(1)
  displayName: string;
}
```

`apps/api/src/schools/dto/school-response.dto.ts`:
```ts
import { School } from '../../entities/school.entity';

export interface SchoolResponseDto {
  id: string;
  name: string;
  locale: string;
  timezone: string;
  status: string;
}

export function toSchoolResponse(school: School): SchoolResponseDto {
  return {
    id: school.id,
    name: school.name,
    locale: school.locale,
    timezone: school.timezone,
    status: school.status,
  };
}
```

- [ ] **Step 4: Implement `SchoolsService`**

`apps/api/src/schools/schools.service.ts`:
```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PasswordService } from '../auth/password.service';
import { validatePasswordPolicy } from '../auth/password-policy';
import { School } from '../entities/school.entity';
import { User } from '../entities/user.entity';
import { PasswordHistory } from '../entities/password-history.entity';
import { CreateSchoolUserDto } from './dto/create-school-user.dto';

@Injectable()
export class SchoolsService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly passwordService: PasswordService,
  ) {}

  async create(name: string): Promise<School> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(School).save({ name });
  }

  async findById(id: string): Promise<School | null> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(School).findOne({ where: { id } });
  }

  async findAll(): Promise<School[]> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(School).find();
  }

  async createUser(schoolId: string, input: CreateSchoolUserDto): Promise<User> {
    const violations = validatePasswordPolicy(input.password);
    if (violations.length > 0) {
      throw new BadRequestException(`Password does not meet policy: ${violations.join(', ')}`);
    }

    const manager = this.tenantContextService.getManager();
    const passwordHash = await this.passwordService.hash(input.password);

    const user = await manager.getRepository(User).save({
      schoolId,
      role: input.role,
      email: input.email ?? null,
      phone: input.phone ?? null,
      passwordHash,
      displayName: input.displayName,
    });

    await manager.getRepository(PasswordHistory).insert({ userId: user.id, passwordHash });

    return user;
  }

  async listUsers(schoolId: string): Promise<User[]> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(User).find({ where: { schoolId } });
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- schools.service`
Expected: PASS, 4 tests.

- [ ] **Step 6: Implement the controller and module**

`apps/api/src/schools/schools.controller.ts`:
```ts
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../auth/token.service';
import { toUserResponse, UserResponseDto } from '../users/dto/user-response.dto';
import { SchoolsService } from './schools.service';
import { CreateSchoolDto } from './dto/create-school.dto';
import { CreateSchoolUserDto } from './dto/create-school-user.dto';
import { SchoolResponseDto, toSchoolResponse } from './dto/school-response.dto';

/** Throws unless the caller is a super_admin or the school_admin of exactly this school. */
function assertCanAccessSchool(user: AccessTokenClaims, schoolId: string): void {
  if (user.role === 'super_admin') return;
  if (user.role === 'school_admin' && user.schoolId === schoolId) return;
  throw new ForbiddenException('You do not have permission to access this school');
}

@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  @Roles('super_admin')
  @Post()
  async create(@Body() dto: CreateSchoolDto): Promise<SchoolResponseDto> {
    const school = await this.schoolsService.create(dto.name);
    return toSchoolResponse(school);
  }

  @Roles('super_admin')
  @Get()
  async findAll(): Promise<SchoolResponseDto[]> {
    const schools = await this.schoolsService.findAll();
    return schools.map(toSchoolResponse);
  }

  @Roles('super_admin', 'school_admin')
  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<SchoolResponseDto> {
    assertCanAccessSchool(user, id);
    const school = await this.schoolsService.findById(id);
    if (!school) {
      throw new NotFoundException('School not found');
    }
    return toSchoolResponse(school);
  }

  @Roles('super_admin', 'school_admin')
  @Post(':id/users')
  async createUser(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() dto: CreateSchoolUserDto,
  ): Promise<UserResponseDto> {
    assertCanAccessSchool(user, id);
    const created = await this.schoolsService.createUser(id, dto);
    return toUserResponse(created);
  }

  @Roles('super_admin', 'school_admin')
  @Get(':id/users')
  async listUsers(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<UserResponseDto[]> {
    assertCanAccessSchool(user, id);
    const users = await this.schoolsService.listUsers(id);
    return users.map(toUserResponse);
  }
}
```

`apps/api/src/schools/schools.module.ts` — imports `AuthModule` rather than
re-declaring its own `PasswordService` provider, so the app has exactly one
`PasswordService` instance (stateless, so a second instance would be harmless, but
one shared provider is the DRY, unsurprising choice):
```ts
import { Module } from '@nestjs/common';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SchoolsController],
  providers: [SchoolsService],
})
export class SchoolsModule {}
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/schools
git commit -m "feat: add SchoolsModule with tenant CRUD and per-school user management"
```

---

### Task 20: Wire everything into `AppModule` — throttling, tenancy, envelope, filter, guard ordering

**Files:**
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/src/auth/auth.module.ts`
- Test: `apps/api/src/app.module.spec.ts`

**Interfaces:**
- Consumes: every module built so far (`AppConfigModule`, `TenancyModule`, `AuthModule`, `UsersModule`, `SchoolsModule`, `HealthController`, `ResponseInterceptor`, `GlobalHttpExceptionFilter`).
- Produces: a fully wired `AppModule`. Guard order is `ThrottlerGuard → JwtAuthGuard → RolesGuard` (rate-limit before auth, auth before role checks); interceptor order is `TenancyInterceptor → ResponseInterceptor` (the DB transaction wraps the whole remaining pipeline, including the response envelope).

**Why the guard/interceptor providers move here:** Task 16 registered `JwtAuthGuard`/`RolesGuard` as `APP_GUARD` inside `AuthModule` to keep that task self-contained. Multiple modules each registering global guards makes the effective order depend on cross-module import resolution, which is fragile and non-obvious to a future reader. Consolidating all three guards (plus the new `ThrottlerGuard`) in one place, in `AppModule`, makes the order a fact you can read off one file.

- [ ] **Step 1: Write the failing test**

`apps/api/src/app.module.spec.ts` (an integration test — needs the dockerized Postgres up and migrated, same as the database-layer tests):
```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';

describe('AppModule wiring', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('responds to /healthz wrapped in the success envelope', async () => {
    const response = await request(app.getHttpServer()).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('responds 401 for a protected route with no token, in the error envelope', async () => {
    const response = await request(app.getHttpServer()).get('/users/me');
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('rate-limits repeated login attempts', async () => {
    const attempts = Array.from({ length: 7 }, () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ emailOrPhone: 'nobody@example.com', password: 'wrong-password-1!' }),
    );
    const responses = await Promise.all(attempts);
    expect(responses.some((r) => r.status === 429)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- app.module`
Expected: FAIL — either a compile error (modules not yet wired) or all three assertions failing against the bare `AppModule` from Task 1.

- [ ] **Step 3: Move guard registration out of `AuthModule`**

In `apps/api/src/auth/auth.module.ts`, remove the `APP_GUARD` providers and the now-unused `APP_GUARD` import — `AuthModule` goes back to exposing only its own services:
```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, RefreshTokenService, MfaService],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
```

- [ ] **Step 4: Wire `AppModule`**

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SchoolsModule } from './schools/schools.module';
import { HealthController } from './health/health.controller';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { TenancyInterceptor } from './tenancy/tenancy.interceptor';
import { ResponseInterceptor } from './common/response.interceptor';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter';

@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] }),
    TenancyModule,
    AuthModule,
    UsersModule,
    SchoolsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate-limit first, then authenticate, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // The transaction wraps the whole remaining pipeline, envelope included.
    { provide: APP_INTERCEPTOR, useClass: TenancyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
  ],
})
export class AppModule {}
```

- [ ] **Step 5: Update `main.ts`** to match what the test expects (validation pipe wired at bootstrap, already present from Task 1 — no change needed there, but confirm `ValidationPipe` options match the test's expectations for `whitelist`/`forbidNonWhitelisted`).

No edit needed if Task 1's `main.ts` is unchanged; this step is a checkpoint, not a diff.

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- app.module`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.module.ts apps/api/src/auth/auth.module.ts apps/api/src/app.module.spec.ts
git commit -m "feat: wire AppModule with ordered guards, interceptors, and rate limiting"
```

---

### Task 21: Seed script — bootstrap the first `super_admin`

**Files:**
- Create: `apps/api/scripts/seed.ts`
- Test: `apps/api/scripts/seed.spec.ts`

**Interfaces:**
- Consumes: `appDataSourceOptions`/`migrationDataSource` (3), `TenantContextService` (11), `PasswordService` (9), `validatePasswordPolicy` (9), `User` entity (5).
- Produces: a `pnpm --filter @transitos/api seed` script, idempotent (safe to run more than once), reading `SEED_SUPER_ADMIN_EMAIL` and `SEED_SUPER_ADMIN_PASSWORD` from the environment rather than hardcoding a default credential.

- [ ] **Step 1: Write the failing test**

`apps/api/scripts/seed.spec.ts`:
```ts
import { DataSource } from 'typeorm';
import { seedSuperAdmin } from './seed';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';
import { User } from '../src/entities/user.entity';
import { appDataSourceOptions } from '../src/database/data-source';
import { migrationDataSource } from '../src/database/data-source.migration';

describe('seedSuperAdmin', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('creates a super_admin with the given credentials', async () => {
    await seedSuperAdmin(tenantContextService, new PasswordService(), {
      email: 'seed-root@example.com',
      password: 'Correct-Horse9!',
    });

    const user = await tenantContextService.runWithTenant(
      { sub: 'bootstrap', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.getRepository(User).findOne({ where: { email: 'seed-root@example.com' } }),
    );

    expect(user?.role).toBe('super_admin');
    expect(user?.schoolId).toBeNull();
  });

  it('is idempotent — running it again does not create a duplicate', async () => {
    await seedSuperAdmin(tenantContextService, new PasswordService(), {
      email: 'seed-root@example.com',
      password: 'Correct-Horse9!',
    });

    const users = await tenantContextService.runWithTenant(
      { sub: 'bootstrap', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.getRepository(User).find({ where: { email: 'seed-root@example.com' } }),
    );

    expect(users).toHaveLength(1);
  });

  it('rejects a password that fails the password policy', async () => {
    await expect(
      seedSuperAdmin(tenantContextService, new PasswordService(), {
        email: 'seed-weak@example.com',
        password: 'weak',
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @transitos/api test -- seed`
Expected: FAIL — `Cannot find module '../scripts/seed'`.

- [ ] **Step 3: Implement**

`apps/api/scripts/seed.ts`:
```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';
import { validatePasswordPolicy } from '../src/auth/password-policy';
import { User } from '../src/entities/user.entity';
import { appDataSourceOptions } from '../src/database/data-source';

export async function seedSuperAdmin(
  tenantContextService: TenantContextService,
  passwordService: PasswordService,
  input: { email: string; password: string },
): Promise<void> {
  const violations = validatePasswordPolicy(input.password);
  if (violations.length > 0) {
    throw new Error(`Seed password does not meet policy: ${violations.join(', ')}`);
  }

  await tenantContextService.runWithTenant(
    { sub: 'bootstrap', schoolId: null, role: 'super_admin', isSuperAdmin: true },
    async (manager) => {
      const repo = manager.getRepository(User);
      const existing = await repo.findOne({ where: { email: input.email } });
      if (existing) {
        return;
      }
      const passwordHash = await passwordService.hash(input.password);
      await repo.save({
        role: 'super_admin',
        email: input.email,
        passwordHash,
        displayName: 'Platform Super Admin',
      });
    },
  );
}

async function main(): Promise<void> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must both be set');
  }

  const dataSource = await new DataSource(appDataSourceOptions).initialize();
  const tenantContextService = new TenantContextService(dataSource);
  try {
    await seedSuperAdmin(tenantContextService, new PasswordService(), { email, password });
    console.log(`Super admin ready: ${email}`);
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @transitos/api test -- seed`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/seed.ts apps/api/scripts/seed.spec.ts
git commit -m "feat: add idempotent super_admin seed script"
```

---

### Task 22: End-to-end tests — full auth lifecycle, MFA, and cross-tenant HTTP isolation

**Files:**
- Create: `apps/api/test/jest-e2e.config.ts`, `apps/api/test/global-setup.ts`, `apps/api/test/helpers/app.ts`
- Create: `apps/api/test/auth-lifecycle.e2e-spec.ts`, `apps/api/test/cross-tenant-isolation.e2e-spec.ts`

**Interfaces:**
- Consumes: `AppModule` (20), `migrationDataSource` (3), `TenantContextService` (11) for direct-DB test fixtures, `PasswordService` (9).
- Produces: `pnpm --filter @transitos/api test:e2e` runs every `*.e2e-spec.ts` against a running Nest app backed by the real (migrated) test database — the acceptance-criteria proof for the whole sub-project.

- [ ] **Step 1: Configure the e2e test runner**

`apps/api/test/jest-e2e.config.ts`:
```ts
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: '.e2e-spec.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  globalSetup: '<rootDir>/test/global-setup.ts',
};

export default config;
```

`apps/api/test/global-setup.ts` — runs once before the e2e suite, ensuring migrations are applied:
```ts
import { migrationDataSource } from '../src/database/data-source.migration';

export default async function globalSetup(): Promise<void> {
  const dataSource = await migrationDataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
```

`apps/api/test/helpers/app.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}
```

- [ ] **Step 2: Write the failing auth-lifecycle e2e test**

`apps/api/test/auth-lifecycle.e2e-spec.ts`:
```ts
import { authenticator } from 'otplib';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/app';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';
import { appDataSourceOptions } from '../src/database/data-source';

describe('Auth lifecycle (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  const passwordService = new PasswordService();

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    tenantContextService = new TenantContextService(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedUser(email: string, role: string, password: string): Promise<void> {
    const hash = await passwordService.hash(password);
    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) =>
        manager.query(
          `INSERT INTO core.users (role, email, password_hash, display_name)
           VALUES ('${role}', '${email}', '${hash}', 'E2E User')`,
        ),
    );
  }

  it('logs in, uses the access token, refreshes, logs out, and the old refresh token then fails', async () => {
    await seedUser('e2e-parent@example.com', 'parent', 'Correct-Horse9!');

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: 'e2e-parent@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken, refreshToken } = login.body.data;

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    const newRefreshToken = refreshed.body.data.refreshToken;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
      .send({ refreshToken: newRefreshToken })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: newRefreshToken })
      .expect(401);
  });

  it('logout-all revokes a session opened from a different device', async () => {
    await seedUser('e2e-two-device@example.com', 'parent', 'Correct-Horse9!');

    const deviceA = await request(app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'device-A')
      .send({ emailOrPhone: 'e2e-two-device@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    const deviceB = await request(app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'device-B')
      .send({ emailOrPhone: 'e2e-two-device@example.com', password: 'Correct-Horse9!' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${deviceA.body.data.accessToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('User-Agent', 'device-B')
      .send({ refreshToken: deviceB.body.data.refreshToken })
      .expect(401);
  });

  it('requires MFA for a school_admin who has enrolled it, and rejects login without completing the challenge', async () => {
    await seedUser('e2e-mfa-admin@example.com', 'school_admin', 'Correct-Horse9!');

    const preMfaLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: 'e2e-mfa-admin@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    const setupResponse = await request(app.getHttpServer())
      .post('/auth/mfa/setup')
      .set('Authorization', `Bearer ${preMfaLogin.body.data.accessToken}`)
      .expect(201);
    const { secret } = setupResponse.body.data;

    await request(app.getHttpServer())
      .post('/auth/mfa/confirm')
      .set('Authorization', `Bearer ${preMfaLogin.body.data.accessToken}`)
      .send({ totpCode: authenticator.generate(secret) })
      .expect(201);

    const secondLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: 'e2e-mfa-admin@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    expect(secondLogin.body.data.mfaRequired).toBe(true);

    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaChallengeToken: secondLogin.body.data.mfaChallengeToken, totpCode: '000000' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({
        mfaChallengeToken: secondLogin.body.data.mfaChallengeToken,
        totpCode: authenticator.generate(secret),
      })
      .expect(201);
  });
});
```

- [ ] **Step 3: Write the failing cross-tenant isolation e2e test**

`apps/api/test/cross-tenant-isolation.e2e-spec.ts`:
```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/app';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';

describe('Cross-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let tenantContextService: TenantContextService;
  const passwordService = new PasswordService();
  let schoolA: string;
  let schoolB: string;

  beforeAll(async () => {
    app = await createTestApp();
    const dataSource = app.get(DataSource);
    tenantContextService = new TenantContextService(dataSource);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [a] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('E2E Isolation School A') RETURNING id`,
        );
        const [b] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('E2E Isolation School B') RETURNING id`,
        );
        schoolA = a.id;
        schoolB = b.id;

        const hash = await passwordService.hash('Correct-Horse9!');
        await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ('${schoolA}', 'school_admin', 'isolation-admin-a@example.com', '${hash}', 'Admin A')`,
        );
        await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ('${schoolB}', 'parent', 'isolation-parent-b@example.com', '${hash}', 'Parent B')`,
        );
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("does not let School A's admin read School B via the school detail endpoint", async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: 'isolation-admin-a@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken } = login.body.data;

    await request(app.getHttpServer())
      .get(`/schools/${schoolB}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/schools/${schoolA}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it("does not let School A's admin list School B's users, even by targeting the URL directly", async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: 'isolation-admin-a@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken } = login.body.data;

    const response = await request(app.getHttpServer())
      .get(`/schools/${schoolB}/users`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    expect(response.body.success).toBe(false);
  });

  it("does not let School A's admin create a user in School B", async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: 'isolation-admin-a@example.com', password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken } = login.body.data;

    await request(app.getHttpServer())
      .post(`/schools/${schoolB}/users`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ role: 'parent', email: 'sneaky@example.com', password: 'Correct-Horse9!', displayName: 'Sneaky' })
      .expect(403);
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `pnpm --filter @transitos/api test:e2e`
Expected: FAIL initially with connection or 404 errors until every prior task is in place — by this point in the plan every dependency already exists, so failures here indicate a wiring bug to fix, not a missing feature. Re-run after any fix.

- [ ] **Step 5: Fix forward until green**

There is no new production code to write for this task — it is the integration proof of Tasks 1–21. If a test fails, the fix belongs in the task that owns the broken behavior (e.g. a 500 instead of a 403 means `assertCanAccessSchool` or a guard from Task 15/19 needs a look), not here.

Run: `pnpm --filter @transitos/api test:e2e`
Expected: PASS, 7 tests across both files.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test
git commit -m "test: add end-to-end auth lifecycle and cross-tenant isolation coverage"
```

---

### Task 23: README and final acceptance verification

**Files:**
- Create: `README.md`
- Modify: none (verification only)

**Interfaces:**
- Consumes: nothing new — this task documents and verifies what Tasks 1–22 built.
- Produces: a documented path from a clean checkout to a running, tested system, and a final pass through the spec's §8 acceptance criteria.

- [ ] **Step 1: Write `README.md`**

```markdown
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
4. Export the variables from `.env` into your shell (or use a tool like `direnv`),
   then create the application's database role:
   ```bash
   pnpm --filter @transitos/api db:bootstrap
   ```
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

## Running tests

```bash
pnpm test          # unit + integration tests (needs Postgres running and migrated)
pnpm test:e2e      # end-to-end HTTP tests (same requirement)
pnpm lint
```

CI (`.github/workflows/ci.yml`) runs all of the above against a fresh Postgres
service container on every push.

## What's here

This is **Sub-project 1: Foundations** — the auth/tenancy substrate every later
sub-project builds on. See
`docs/superpowers/specs/2026-09-05-foundations-design.md` for what it does and
does not cover, and `docs/superpowers/specs/engineering-standards.md` for the
security/privacy standards the whole platform is held to.
```

- [ ] **Step 2: Follow the README from a clean state**

Run, in order, exactly what the README says (steps 1–7), on a machine/container
where `docker compose down -v` has just removed any prior volume. Confirm each
step succeeds before moving to the next.

- [ ] **Step 3: Verify each spec acceptance criterion by hand**

Spec `docs/superpowers/specs/2026-09-05-foundations-design.md` §8, checked against
what's now running:

- [ ] `docker-compose up` + the README's steps bring up a working system with no
  undocumented manual step.
- [ ] The seeded super_admin can log in (`POST /auth/login`), create a school
  (`POST /schools`), and create a school_admin for it (`POST /schools/:id/users`) —
  exercise this by hand with `curl` or `httpie` against the running dev server.
- [ ] That school_admin can log in and `GET /schools/:id/users` for their own
  school, and gets 403 for a second school's id.
- [ ] That school_admin can enroll MFA (`/auth/mfa/setup` → `/auth/mfa/confirm`)
  and a subsequent login returns `mfaRequired: true` until `/auth/mfa/verify`
  succeeds.
- [ ] `/auth/logout` revokes only the presented session; `/auth/logout-all`
  revokes every session for that user (already proven in Task 22, re-confirm by
  hand once here).
- [ ] Connect to Postgres directly as the app role
  (`psql "$DATABASE_URL"`) and confirm `UPDATE audit.audit_logs SET action = 'x'`
  fails with a permission error, not an RLS error — permission denied, not zero
  rows affected.
- [ ] `pnpm test && pnpm test:e2e && pnpm lint` all pass locally and in CI.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup instructions and final acceptance verification"
```

This is the last task in the plan. Sub-project 1 (Foundations) is complete once
this task's checklist is fully checked — proceed to brainstorming Sub-project 2
(Core transport backend + Admin web) per `docs/superpowers/specs/engineering-standards.md`.
