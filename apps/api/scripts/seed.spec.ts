import { DataSource } from 'typeorm';
import { seedSuperAdmin } from './seed';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';
import { User } from '../src/entities/user.entity';
import { appDataSourceOptions } from '../src/database/data-source';
import { migrationDataSource } from '../src/database/data-source.migration';
import { randomUUID } from 'crypto';

describe('seedSuperAdmin', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  const seedEmail = `seed-root-${randomUUID()}@example.com`;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('creates a super_admin with the given credentials', async () => {
    await seedSuperAdmin(tenantContextService, new PasswordService(), {
      email: seedEmail,
      password: 'Correct-Horse9!',
    });

    const user = await tenantContextService.runWithTenant(
      { sub: 'bootstrap', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.getRepository(User).findOne({ where: { email: seedEmail } }),
    );

    expect(user?.role).toBe('super_admin');
    expect(user?.schoolId).toBeNull();
  });

  it('is idempotent — running it again does not create a duplicate', async () => {
    await seedSuperAdmin(tenantContextService, new PasswordService(), {
      email: seedEmail,
      password: 'Correct-Horse9!',
    });

    const users = await tenantContextService.runWithTenant(
      { sub: 'bootstrap', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.getRepository(User).find({ where: { email: seedEmail } }),
    );

    expect(users).toHaveLength(1);
  });

  it('rejects a password that fails the password policy', async () => {
    await expect(
      seedSuperAdmin(tenantContextService, new PasswordService(), {
        email: `seed-weak-${randomUUID()}@example.com`,
        password: 'weak',
      }),
    ).rejects.toThrow();
  });
});
