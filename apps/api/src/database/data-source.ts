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
