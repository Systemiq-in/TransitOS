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
