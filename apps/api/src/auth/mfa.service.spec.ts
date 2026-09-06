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

  /** Creates a fresh super_admin row so a test can drive its own enrollment
   * lifecycle without inheriting an `enabled_at` set by an earlier test on the
   * shared `userId` above (see I6: beginEnrollment no longer clears enabled_at,
   * so once a user is enabled in one test it stays enabled for the rest of the
   * suite unless isolated like this). */
  async function createUser(email: string): Promise<string> {
    return tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [user] = await manager.query(
          `INSERT INTO core.users (role, email, password_hash, display_name)
           VALUES ('super_admin', $1, 'hash', 'Root') RETURNING id`,
          [email],
        );
        return user.id as string;
      },
    );
  }

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

  it('returns false for a correct code when enrollment was never confirmed', async () => {
    const { secret } = await runNull(() =>
      service.beginEnrollment(userId, `mfa-test-unconfirmed-${runId}@example.com`),
    );
    const validCode = authenticator.generate(secret);
    expect(await runNull(() => service.verifyCode(userId, validCode))).toBe(false);
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
    const freshUserId = await createUser(`mfa-test-2-${runId}@example.com`);
    await runNull(() => service.beginEnrollment(freshUserId, `mfa-test-2-${runId}@example.com`));
    await expect(
      runNull(() => service.confirmEnrollment(freshUserId, '000000')),
    ).rejects.toThrow();
    expect(await runNull(() => service.isEnabled(freshUserId))).toBe(false);
  });

  it('rejects confirmEnrollment when enrollment was never begun', async () => {
    const noCredUserId = randomUUID();
    await expect(
      runNull(() => service.confirmEnrollment(noCredUserId, '000000')),
    ).rejects.toThrow();
  });

  it('verifies a correct code once enabled', async () => {
    const freshUserId = await createUser(`mfa-test-3-${runId}@example.com`);
    const { secret } = await runNull(() =>
      service.beginEnrollment(freshUserId, `mfa-test-3-${runId}@example.com`),
    );
    const code = authenticator.generate(secret);
    await runNull(() => service.confirmEnrollment(freshUserId, code));

    const nextCode = authenticator.generate(secret);
    expect(await runNull(() => service.verifyCode(freshUserId, nextCode))).toBe(true);
  });

  it('rejects an incorrect code once enabled', async () => {
    const freshUserId = await createUser(`mfa-test-4-${runId}@example.com`);
    const { secret } = await runNull(() =>
      service.beginEnrollment(freshUserId, `mfa-test-4-${runId}@example.com`),
    );
    const code = authenticator.generate(secret);
    await runNull(() => service.confirmEnrollment(freshUserId, code));

    expect(await runNull(() => service.verifyCode(freshUserId, '000000'))).toBe(false);
  });

  it('re-enrollment before confirmation updates the existing row rather than inserting a second one', async () => {
    const freshUserId = await createUser(`mfa-test-5-${runId}@example.com`);
    await runNull(() => service.beginEnrollment(freshUserId, `mfa-test-5a-${runId}@example.com`));
    await runNull(() => service.beginEnrollment(freshUserId, `mfa-test-5b-${runId}@example.com`));

    const manager = dataSource.manager;
    const rows = await manager.query(`SELECT id FROM core.mfa_credentials WHERE user_id = $1`, [
      freshUserId,
    ]);
    expect(rows).toHaveLength(1);
  });

  // I6: re-enrolling an already-enabled credential without proving possession of
  // the current device would silently turn MFA off — the entire vulnerability
  // this fix closes.
  describe('re-enrolling an already-enabled credential (I6)', () => {
    async function enableFreshUser(label: string): Promise<{ userId: string; secret: string }> {
      const email = `mfa-test-i6-${label}-${runId}@example.com`;
      const freshUserId = await createUser(email);
      const { secret } = await runNull(() => service.beginEnrollment(freshUserId, email));
      await runNull(() => service.confirmEnrollment(freshUserId, authenticator.generate(secret)));
      return { userId: freshUserId, secret };
    }

    it('rejects re-enrollment without a current TOTP code, and MFA stays enabled', async () => {
      const { userId: enabledUserId, secret } = await enableFreshUser('no-code');

      await expect(
        runNull(() => service.beginEnrollment(enabledUserId, 'irrelevant-label')),
      ).rejects.toThrow();

      expect(await runNull(() => service.isEnabled(enabledUserId))).toBe(true);
      // The old (still-valid) secret must not have been replaced.
      expect(await runNull(() => service.verifyCode(enabledUserId, authenticator.generate(secret)))).toBe(
        true,
      );
    });

    it('rejects re-enrollment with a wrong current TOTP code, and MFA stays enabled', async () => {
      const { userId: enabledUserId, secret } = await enableFreshUser('wrong-code');

      await expect(
        runNull(() => service.beginEnrollment(enabledUserId, 'irrelevant-label', '000000')),
      ).rejects.toThrow();

      expect(await runNull(() => service.isEnabled(enabledUserId))).toBe(true);
      expect(await runNull(() => service.verifyCode(enabledUserId, authenticator.generate(secret)))).toBe(
        true,
      );
    });

    it('proceeds with a valid current TOTP code, replacing the secret while MFA remains enabled throughout', async () => {
      const { userId: enabledUserId, secret: oldSecret } = await enableFreshUser('valid-code');
      const validCode = authenticator.generate(oldSecret);

      const { secret: newSecret } = await runNull(() =>
        service.beginEnrollment(enabledUserId, 'irrelevant-label', validCode),
      );

      expect(newSecret).not.toBe(oldSecret);
      // enabled_at was never cleared during the swap.
      expect(await runNull(() => service.isEnabled(enabledUserId))).toBe(true);

      await runNull(() =>
        service.confirmEnrollment(enabledUserId, authenticator.generate(newSecret)),
      );
      expect(
        await runNull(() => service.verifyCode(enabledUserId, authenticator.generate(newSecret))),
      ).toBe(true);
    });
  });
});
