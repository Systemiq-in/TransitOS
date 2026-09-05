import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { SchoolsService } from './schools.service';
import { PasswordService } from '../auth/password.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('SchoolsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: SchoolsService;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new SchoolsService(tenantContextService, new PasswordService());
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const asSuperAdmin = <T>(work: () => Promise<T>) =>
    tenantContextService.runWithTenant(
      { sub: 'root', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  it('creates a school and finds it by id', async () => {
    const school = await asSuperAdmin(() => service.create('New School'));
    const found = await asSuperAdmin(() => service.findById(school.id));
    expect(found?.name).toBe('New School');
  });

  it('creates a user under a school with a policy-valid password, hashed', async () => {
    const school = await asSuperAdmin(() => service.create('User Test School'));
    const email = `admin-${randomUUID()}@usertestschool.example.com`;

    const user = await asSuperAdmin(() =>
      service.createUser(school.id, {
        role: 'school_admin',
        email,
        password: 'Correct-Horse9!',
        displayName: 'The Admin',
      }),
    );

    expect(user.passwordHash).not.toBe('Correct-Horse9!');
    expect(user.schoolId).toBe(school.id);
  });

  it('rejects creating a user with a policy-violating password, and creates no user row', async () => {
    const school = await asSuperAdmin(() => service.create('Weak Password School'));

    await expect(
      asSuperAdmin(() =>
        service.createUser(school.id, {
          role: 'parent',
          email: `weak-${randomUUID()}@weakpasswordschool.example.com`,
          password: 'weak',
          displayName: 'Weak Password',
        }),
      ),
    ).rejects.toThrow();

    const { total } = await asSuperAdmin(() => service.listUsers(school.id, 50, 0));
    expect(total).toBe(0);
  });

  it('lists only the users belonging to the given school', async () => {
    const schoolA = await asSuperAdmin(() => service.create('List Test A'));
    const schoolB = await asSuperAdmin(() => service.create('List Test B'));
    const emailA = `a1-${randomUUID()}@listtest.example.com`;
    const emailB = `b1-${randomUUID()}@listtest.example.com`;
    await asSuperAdmin(() =>
      service.createUser(schoolA.id, {
        role: 'parent',
        email: emailA,
        password: 'Correct-Horse9!',
        displayName: 'A1',
      }),
    );
    await asSuperAdmin(() =>
      service.createUser(schoolB.id, {
        role: 'parent',
        email: emailB,
        password: 'Correct-Horse9!',
        displayName: 'B1',
      }),
    );

    const { items } = await asSuperAdmin(() => service.listUsers(schoolA.id, 50, 0));
    expect(items.map((u) => u.email)).toEqual([emailA]);
  });

  it('findAll returns a paginated shape whose page never exceeds the requested limit or the reported total', async () => {
    await asSuperAdmin(() => service.create(`Pagination Shape School ${randomUUID()}`));

    const { items, total } = await asSuperAdmin(() => service.findAll(50, 0));

    expect(Array.isArray(items)).toBe(true);
    expect(typeof total).toBe('number');
    expect(items.length).toBeLessThanOrEqual(50);
    expect(items.length).toBeLessThanOrEqual(total);
    expect(items.length).toBe(Math.min(total, 50));
  });

  it('listUsers: limit genuinely restricts the returned page while total still reports the full scoped count', async () => {
    const school = await asSuperAdmin(() => service.create(`Pagination Users School ${randomUUID()}`));
    const totalCreated = 5;
    for (let i = 0; i < totalCreated; i += 1) {
      await asSuperAdmin(() =>
        service.createUser(school.id, {
          role: 'parent',
          email: `paginated-${i}-${randomUUID()}@paginationusers.example.com`,
          password: 'Correct-Horse9!',
          displayName: `Paginated User ${i}`,
        }),
      );
    }

    const firstPage = await asSuperAdmin(() => service.listUsers(school.id, 2, 0));
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(totalCreated);

    const lastPage = await asSuperAdmin(() => service.listUsers(school.id, 2, 4));
    expect(lastPage.items).toHaveLength(1);
    expect(lastPage.total).toBe(totalCreated);

    const fullPage = await asSuperAdmin(() => service.listUsers(school.id, 50, 0));
    expect(fullPage.items).toHaveLength(totalCreated);
    expect(fullPage.total).toBe(totalCreated);
  });
});
