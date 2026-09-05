import { randomUUID, createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { RefreshTokenService, fingerprint } from './refresh-token.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('RefreshTokenService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: RefreshTokenService;
  let userId: string;

  const runId = randomUUID();
  const testEmail = `refresh-test-${runId}@example.com`;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new RefreshTokenService(tenantContextService, {
      get: () => 604800,
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

  it('issues a token that rotate() accepts with a matching device', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    const rotated = await runNull(() => service.rotate(rawToken, 'device-A'));
    expect(rotated.userId).toBe(userId);
    expect(rotated.rawToken).not.toBe(rawToken);
  });

  it('rejects rotate() with a mismatched device fingerprint', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    await expect(runNull(() => service.rotate(rawToken, 'device-B'))).rejects.toThrow();
  });

  it('rejects rotate() after the token has already been rotated once', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    await runNull(() => service.rotate(rawToken, 'device-A'));
    await expect(runNull(() => service.rotate(rawToken, 'device-A'))).rejects.toThrow();
  });

  it('rejects rotate() after revoke()', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    await runNull(() => service.revoke(rawToken));
    await expect(runNull(() => service.rotate(rawToken, 'device-A'))).rejects.toThrow();
  });

  it('revokeAllForUser() invalidates every session for that user', async () => {
    const first = await runNull(() => service.issue(userId, 'device-A'));
    const second = await runNull(() => service.issue(userId, 'device-B'));
    await runNull(() => service.revokeAllForUser(userId));

    await expect(runNull(() => service.rotate(first.rawToken, 'device-A'))).rejects.toThrow();
    await expect(runNull(() => service.rotate(second.rawToken, 'device-B'))).rejects.toThrow();
  });

  it('rejects rotate() when the token is expired', async () => {
    const { rawToken } = await runNull(() => service.issue(userId, 'device-A'));
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await runNull(() =>
      tenantContextService
        .getManager()
        .query(
          `UPDATE core.refresh_tokens SET expires_at = now() - interval '1 second'
           WHERE token_hash = $1`,
          [tokenHash],
        ),
    );
    await expect(runNull(() => service.rotate(rawToken, 'device-A'))).rejects.toThrow();
  });

  it('fingerprint() is deterministic for the same device info', () => {
    expect(fingerprint('device-A')).toBe(fingerprint('device-A'));
    expect(fingerprint('device-A')).not.toBe(fingerprint('device-B'));
  });
});
