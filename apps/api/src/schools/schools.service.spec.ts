import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { SchoolsService } from './schools.service';
import { PasswordService } from '../auth/password.service';
import { AuditService } from '../audit/audit.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('SchoolsService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: SchoolsService;
  let auditService: AuditService;
  // C2: actor_user_id on audit.audit_logs is a real FK to core.users(id), so the
  // "actor" behind every create() / createUser() call in this suite must be a
  // real seeded user, not a synthetic claims.sub string.
  let rootUserId: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    auditService = new AuditService(tenantContextService);
    service = new SchoolsService(tenantContextService, new PasswordService(), auditService);

    rootUserId = await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [user] = await manager.query(
          `INSERT INTO core.users (role, email, password_hash, display_name)
           VALUES ('super_admin', $1, 'hash', 'Root') RETURNING id`,
          [`schools-service-root-${randomUUID()}@example.com`],
        );
        return user.id as string;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const asSuperAdmin = <T>(work: () => Promise<T>) =>
    tenantContextService.runWithTenant(
      { sub: rootUserId, schoolId: null, role: 'super_admin', isSuperAdmin: true },
      work,
    );

  it('creates a school and finds it by id', async () => {
    const school = await asSuperAdmin(() => service.create('New School', rootUserId));
    const found = await asSuperAdmin(() => service.findById(school.id));
    expect(found?.name).toBe('New School');
  });

  it('creates a user under a school with a policy-valid password, hashed', async () => {
    const school = await asSuperAdmin(() => service.create('User Test School', rootUserId));
    const email = `admin-${randomUUID()}@usertestschool.example.com`;

    const user = await asSuperAdmin(() =>
      service.createUser(
        school.id,
        {
          role: 'school_admin',
          email,
          password: 'Correct-Horse9!',
          displayName: 'The Admin',
        },
        rootUserId,
      ),
    );

    expect(user.passwordHash).not.toBe('Correct-Horse9!');
    expect(user.schoolId).toBe(school.id);
  });

  it('rejects creating a user with a policy-violating password, and creates no user row', async () => {
    const school = await asSuperAdmin(() => service.create('Weak Password School', rootUserId));

    await expect(
      asSuperAdmin(() =>
        service.createUser(
          school.id,
          {
            role: 'parent',
            email: `weak-${randomUUID()}@weakpasswordschool.example.com`,
            password: 'weak',
            displayName: 'Weak Password',
          },
          rootUserId,
        ),
      ),
    ).rejects.toThrow();

    const { total } = await asSuperAdmin(() => service.listUsers(school.id, 50, 0));
    expect(total).toBe(0);
  });

  it('lists only the users belonging to the given school', async () => {
    const schoolA = await asSuperAdmin(() => service.create('List Test A', rootUserId));
    const schoolB = await asSuperAdmin(() => service.create('List Test B', rootUserId));
    const emailA = `a1-${randomUUID()}@listtest.example.com`;
    const emailB = `b1-${randomUUID()}@listtest.example.com`;
    await asSuperAdmin(() =>
      service.createUser(
        schoolA.id,
        {
          role: 'parent',
          email: emailA,
          password: 'Correct-Horse9!',
          displayName: 'A1',
        },
        rootUserId,
      ),
    );
    await asSuperAdmin(() =>
      service.createUser(
        schoolB.id,
        {
          role: 'parent',
          email: emailB,
          password: 'Correct-Horse9!',
          displayName: 'B1',
        },
        rootUserId,
      ),
    );

    const { items } = await asSuperAdmin(() => service.listUsers(schoolA.id, 50, 0));
    expect(items.map((u) => u.email)).toEqual([emailA]);
  });

  it('findAll returns a paginated shape whose page never exceeds the requested limit or the reported total', async () => {
    await asSuperAdmin(() => service.create(`Pagination Shape School ${randomUUID()}`, rootUserId));

    const { items, total } = await asSuperAdmin(() => service.findAll(50, 0));

    expect(Array.isArray(items)).toBe(true);
    expect(typeof total).toBe('number');
    expect(items.length).toBeLessThanOrEqual(50);
    expect(items.length).toBeLessThanOrEqual(total);
    expect(items.length).toBe(Math.min(total, 50));
  });

  it('listUsers: limit genuinely restricts the returned page while total still reports the full scoped count', async () => {
    const school = await asSuperAdmin(() =>
      service.create(`Pagination Users School ${randomUUID()}`, rootUserId),
    );
    const totalCreated = 5;
    for (let i = 0; i < totalCreated; i += 1) {
      await asSuperAdmin(() =>
        service.createUser(
          school.id,
          {
            role: 'parent',
            email: `paginated-${i}-${randomUUID()}@paginationusers.example.com`,
            password: 'Correct-Horse9!',
            displayName: `Paginated User ${i}`,
          },
          rootUserId,
        ),
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

  // C2: POST /schools and POST /schools/:id/users are the only two privileged
  // mutations in this sub-project and were previously not audited at all.
  describe('audit logging (C2)', () => {
    async function auditRowsFor(action: string, entityId: string) {
      return tenantContextService.runWithTenant(
        { sub: rootUserId, schoolId: null, role: 'super_admin', isSuperAdmin: true },
        (manager) =>
          manager.query(
            `SELECT action, entity_type, entity_id, actor_user_id, school_id
             FROM audit.audit_logs WHERE action = $1 AND entity_id = $2`,
            [action, entityId],
          ),
      );
    }

    it('records a school.created row when a school is created', async () => {
      const school = await asSuperAdmin(() => service.create(`Audited School ${randomUUID()}`, rootUserId));

      const rows = await auditRowsFor('school.created', school.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_type).toBe('school');
      expect(rows[0].actor_user_id).toBe(rootUserId);
      expect(rows[0].school_id).toBe(school.id);
    });

    it('records a user.created row when a user is created', async () => {
      const school = await asSuperAdmin(() => service.create(`Audited User School ${randomUUID()}`, rootUserId));
      const user = await asSuperAdmin(() =>
        service.createUser(
          school.id,
          {
            role: 'parent',
            email: `audited-${randomUUID()}@example.com`,
            password: 'Correct-Horse9!',
            displayName: 'Audited User',
          },
          rootUserId,
        ),
      );

      const rows = await auditRowsFor('user.created', user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_type).toBe('user');
      expect(rows[0].actor_user_id).toBe(rootUserId);
      expect(rows[0].school_id).toBe(school.id);
    });
  });
});
