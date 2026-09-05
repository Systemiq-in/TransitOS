import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { UsersService } from './users.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('UsersService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: UsersService;
  let schoolA: string;
  let userA: string;
  let userAEmail: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new UsersService(tenantContextService);

    // Generate unique email per test run to comply with R18
    userAEmail = `user-${randomUUID()}@example.com`;

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [school] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('Users Test School') RETURNING id`,
        );
        schoolA = school.id;
        const [user] = await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ('${schoolA}', 'parent', '${userAEmail}', 'hash', 'Find Me') RETURNING id`,
        );
        userA = user.id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('finds a user within its own tenant scope', async () => {
    const user = await tenantContextService.runWithTenant(
      { sub: userA, schoolId: schoolA, role: 'parent', isSuperAdmin: false },
      () => service.findById(userA),
    );
    expect(user?.email).toBe(userAEmail);
  });

  it('returns null for a user outside the current tenant scope', async () => {
    const user = await tenantContextService.runWithTenant(
      { sub: 'other', schoolId: '00000000-0000-0000-0000-000000000000', role: 'parent', isSuperAdmin: false },
      () => service.findById(userA),
    );
    expect(user).toBeNull();
  });
});
