import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('auth support tables', () => {
  let migrator: DataSource;
  let app: DataSource;
  let userId: string;
  const runId = randomUUID();
  const rootEmail = `task6-root-${runId}@example.com`;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    const [user] = await runner.query(
      `INSERT INTO core.users (role, email, password_hash, display_name)
       VALUES ('super_admin', '${rootEmail}', 'hash', 'Root') RETURNING id`,
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
    const uniqueTokenHash = `tokenhash-${runId}`;
    const [row] = await app.query(
      `INSERT INTO core.refresh_tokens (user_id, token_hash, device_fingerprint, expires_at)
       VALUES ('${userId}', '${uniqueTokenHash}', 'fingerprint', now() + interval '7 days')
       RETURNING id, revoked_at`,
    );
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.revoked_at).toBeNull();
  });

  it('rejects two enrolled MFA credentials for the same user', async () => {
    const uniqueCipher = `cipher-${runId}`;
    const uniqueCipher2 = `cipher2-${runId}`;
    await app.query(
      `INSERT INTO core.mfa_credentials (user_id, secret_encrypted) VALUES ('${userId}', '${uniqueCipher}')`,
    );
    await expect(
      app.query(
        `INSERT INTO core.mfa_credentials (user_id, secret_encrypted) VALUES ('${userId}', '${uniqueCipher2}')`,
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('keeps password history rows for a user', async () => {
    const uniquePasswordHash = `old-hash-${runId}`;
    await app.query(
      `INSERT INTO core.password_history (user_id, password_hash) VALUES ('${userId}', '${uniquePasswordHash}')`,
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
