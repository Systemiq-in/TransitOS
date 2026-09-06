import 'reflect-metadata';
import { Client } from 'pg';
import { validateEnv } from '../src/config/env.schema';

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * Extracts the database name from a connection URL and validates it as a
 * Postgres identifier. The name is interpolated into DDL, where Postgres offers
 * no parameter binding — this validation, not the URL parser's escaping, is what
 * makes that interpolation safe.
 */
export function databaseNameFromUrl(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!POSTGRES_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to use unsafe database name from connection URL: ${JSON.stringify(name)}`);
  }
  return name;
}

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
    const dbName = databaseNameFromUrl(env.DATABASE_MIGRATION_URL);
    await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${env.APP_DB_ROLE}`);
  } finally {
    await client.end();
  }
}

// Only run when executed directly (e.g. `ts-node scripts/bootstrap-db.ts`), not
// when imported by tests for `databaseNameFromUrl`.
if (require.main === module) {
  void main().catch((error) => {
    // A TypeORM QueryFailedError carries the failed query's `parameters`, which
    // on this path can include the app role's password. Log only the message.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
