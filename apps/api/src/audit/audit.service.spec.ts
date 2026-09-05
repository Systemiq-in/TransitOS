import { DataSource } from 'typeorm';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditService } from './audit.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('AuditService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let service: AuditService;
  let schoolId: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    service = new AuditService(tenantContextService);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [school] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('Audit Test School') RETURNING id`,
        );
        schoolId = school.id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('writes a record visible to that school afterward', async () => {
    await tenantContextService.runWithTenant(null, () =>
      service.record({
        schoolId,
        actorUserId: null,
        action: 'user.login',
        metadata: { via: 'password' },
      }),
    );

    const rows = await tenantContextService.runWithTenant(
      { sub: 'admin', schoolId, role: 'school_admin', isSuperAdmin: false },
      (manager) => manager.query(`SELECT action, metadata FROM audit.audit_logs WHERE school_id = '${schoolId}'`),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('user.login');
    expect(rows[0].metadata).toEqual({ via: 'password' });
  });

  it('accepts a null schoolId for platform-level actions', async () => {
    await tenantContextService.runWithTenant(null, () =>
      service.record({ schoolId: null, actorUserId: null, action: 'school.created' }),
    );

    const rows = await tenantContextService.runWithTenant(
      { sub: 'root', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) =>
        manager.query(`SELECT action FROM audit.audit_logs WHERE school_id IS NULL AND action = 'school.created'`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
