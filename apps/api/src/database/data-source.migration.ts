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
