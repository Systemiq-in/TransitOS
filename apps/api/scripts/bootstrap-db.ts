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
