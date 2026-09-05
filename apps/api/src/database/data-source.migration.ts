import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.schema';

const env = validateEnv(process.env);

export const migrationDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_MIGRATION_URL,
  // Matches only timestamp-prefixed migration files (e.g. `1757030000000-Name.ts`),
  // never the `*.spec.ts` test files that live alongside them in this directory.
  migrations: [__dirname + '/migrations/[0-9]*.{ts,js}'],
  migrationsTableName: 'schema_migrations',
  synchronize: false,
  logging: false,
});
