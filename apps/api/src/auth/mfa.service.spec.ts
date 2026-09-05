import { randomUUID } from 'crypto';
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

  const runId = randomUUID();
  const testEmail = `mfa-test-${runId}@example.com`;

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
           VALUES ('super_admin', $1, 'hash', 'Root') RETURNING id`,
          [testEmail],
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

  it('reports MFA disabled after beginEnrollment but before confirmation', async () => {
    await runNull(() => service.beginEnrollment(userId, testEmail));
    expect(await runNull(() => service.isEnabled(userId))).toBe(false);
  });

  it('verifyCode returns false for a user with no credential row at all', async () => {
    const noCredUserId = randomUUID();
    expect(await runNull(() => service.verifyCode(noCredUserId, '000000'))).toBe(false);
  });

  it('verifyCode returns false for a begun-but-unconfirmed enrollment', async () => {
    await runNull(() => service.beginEnrollment(userId, testEmail));
    expect(await runNull(() => service.verifyCode(userId, '000000'))).toBe(false);
  });

  it('stores the secret encrypted, not in plaintext', async () => {
    const { secret } = await runNull(() => service.beginEnrollment(userId, testEmail));
    const manager = dataSource.manager;
    const row = await manager.query(
      `SELECT secret_encrypted FROM core.mfa_credentials WHERE user_id = $1`,
      [userId],
    );
    expect(row[0].secret_encrypted).not.toBe(secret);
    expect(row[0].secret_encrypted).not.toContain(secret);
  });

  it('completes enrollment with a valid TOTP code and enables MFA', async () => {
    const { secret } = await runNull(() => service.beginEnrollment(userId, testEmail));
    const code = authenticator.generate(secret);

    await runNull(() => service.confirmEnrollment(userId, code));

    expect(await runNull(() => service.isEnabled(userId))).toBe(true);
  });

  it('rejects confirmEnrollment with an invalid code', async () => {
    await runNull(() => service.beginEnrollment(userId, `mfa-test-2-${runId}@example.com`));
    await expect(runNull(() => service.confirmEnrollment(userId, '000000'))).rejects.toThrow();
  });

  it('rejects confirmEnrollment when enrollment was never begun', async () => {
    const noCredUserId = randomUUID();
    await expect(
      runNull(() => service.confirmEnrollment(noCredUserId, '000000')),
    ).rejects.toThrow();
  });

  it('verifies a correct code once enabled', async () => {
    const { secret } = await runNull(() =>
      service.beginEnrollment(userId, `mfa-test-3-${runId}@example.com`),
    );
    const code = authenticator.generate(secret);
    await runNull(() => service.confirmEnrollment(userId, code));

    const nextCode = authenticator.generate(secret);
    expect(await runNull(() => service.verifyCode(userId, nextCode))).toBe(true);
  });

  it('rejects an incorrect code once enabled', async () => {
    const { secret } = await runNull(() =>
      service.beginEnrollment(userId, `mfa-test-4-${runId}@example.com`),
    );
    const code = authenticator.generate(secret);
    await runNull(() => service.confirmEnrollment(userId, code));

    expect(await runNull(() => service.verifyCode(userId, '000000'))).toBe(false);
  });

  it('re-enrollment updates the existing row rather than inserting a second one', async () => {
    await runNull(() => service.beginEnrollment(userId, `mfa-test-5a-${runId}@example.com`));
    await runNull(() => service.beginEnrollment(userId, `mfa-test-5b-${runId}@example.com`));

    const manager = dataSource.manager;
    const rows = await manager.query(`SELECT id FROM core.mfa_credentials WHERE user_id = $1`, [
      userId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
