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
