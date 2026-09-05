import { DataSource } from 'typeorm';
import { TenantContextService } from './tenant-context.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';

describe('TenantContextService', () => {
  let dataSource: DataSource;
  let service: TenantContextService;
  let schoolA: string;
  let schoolB: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    service = new TenantContextService(dataSource);

    await service.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const a = await manager.query(`INSERT INTO core.schools (name) VALUES ('A') RETURNING id`);
        const b = await manager.query(`INSERT INTO core.schools (name) VALUES ('B') RETURNING id`);
        schoolA = a[0].id;
        schoolB = b[0].id;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('scopes queries to the given school for the duration of the callback', async () => {
    const rows = await service.runWithTenant(
      { sub: 'u1', schoolId: schoolA, role: 'school_admin', isSuperAdmin: false },
      (manager) => manager.query(`SELECT id FROM core.schools`),
    );
    expect(rows).toEqual([{ id: schoolA }]);
  });

  it('gives a super_admin visibility of every school', async () => {
    const rows = await service.runWithTenant(
      { sub: 'u2', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) =>
        manager.query(`SELECT id FROM core.schools WHERE id IN ($1, $2) ORDER BY id`, [
          schoolA,
          schoolB,
        ]),
    );
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([schoolA, schoolB].sort());
  });

  it('runs an unauthenticated context (claims=null) with no tenant visibility', async () => {
    const rows = await service.runWithTenant(null, (manager) =>
      manager.query(`SELECT id FROM core.schools`),
    );
    expect(rows).toEqual([]);
  });

  it('throws if getManager() is called outside runWithTenant', () => {
    expect(() => service.getManager()).toThrow(/runWithTenant/);
  });

  it('rolls back the transaction when the callback throws', async () => {
    // Note: this write must run as super_admin — core.schools' RLS (Task 4) has no
    // INSERT/UPDATE policy for a tenant-scoped session at all (only
    // schools_super_admin_all, FOR ALL, and schools_own_row_select, SELECT-only), so a
    // school_admin INSERT here is rejected by RLS before ever reaching the `throw`.
    // The property under test — rollback on throw — is orthogonal to tenant scoping,
    // so a super_admin context (matching how beforeAll seeds schools) exercises it
    // without fighting a policy from an earlier, already-verified task. Also: the id
    // is left to its DEFAULT (fresh uuid) rather than reusing schoolA's existing id —
    // reusing it would violate the primary key before the explicit throw is ever
    // reached, masking the property under test with an unrelated constraint error.
    await expect(
      service.runWithTenant(
        { sub: 'u2', schoolId: null, role: 'super_admin', isSuperAdmin: true },
        async (manager) => {
          await manager.query(`INSERT INTO core.schools (name) VALUES ('dup')`);
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    const rows = await service.runWithTenant(
      { sub: 'u2', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      (manager) => manager.query(`SELECT count(*)::int AS count FROM core.schools WHERE name = 'dup'`),
    );
    expect(rows[0].count).toBe(0);
  });

  it('isolates concurrent calls from each other (AsyncLocalStorage does not leak)', async () => {
    const [resultA, resultB] = await Promise.all([
      service.runWithTenant(
        { sub: 'u1', schoolId: schoolA, role: 'school_admin', isSuperAdmin: false },
        (manager) => manager.query(`SELECT id FROM core.schools`),
      ),
      service.runWithTenant(
        { sub: 'u3', schoolId: schoolB, role: 'school_admin', isSuperAdmin: false },
        (manager) => manager.query(`SELECT id FROM core.schools`),
      ),
    ]);
    expect(resultA).toEqual([{ id: schoolA }]);
    expect(resultB).toEqual([{ id: schoolB }]);
  });

  // The test above passes the callback its own `manager` parameter directly, which
  // is captured via closure per-call and is therefore safe even under a naive
  // single-shared-field implementation of getManager() — it never actually reads
  // the shared field. This test instead calls `service.getManager()` from inside
  // the callback, after an await, which is exactly the guardrail getManager() exists
  // to protect: a handler reaching back into shared per-request state after
  // yielding control. Call A awaits long enough (50ms) for call B to start, run its
  // entire transaction (connect/SET LOCAL/query/commit/release, well under 50ms
  // locally) and — under a naive `this.currentManager` field — leave that field
  // either null (reset in B's `finally`) or pointing at B's manager by the time A
  // resumes and calls getManager() again. A correct AsyncLocalStorage-backed
  // implementation keeps A's own manager bound to A's continuation regardless of
  // what B does concurrently, so A's second read is still A's own manager.
  it('keeps getManager() correct for a call resumed after a concurrent call fully completes', async () => {
    const resultA = service.runWithTenant(
      { sub: 'u1', schoolId: schoolA, role: 'school_admin', isSuperAdmin: false },
      async () => {
        service.getManager(); // first read, immediately on entry — establishes context
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Second read, after yielding — this is where a shared mutable field would
        // have been stomped on by the concurrent call B below.
        return service.getManager().query(`SELECT id FROM core.schools`);
      },
    );

    // Give A a moment to connect/begin/SET LOCAL before B starts.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const resultB = await service.runWithTenant(
      { sub: 'u3', schoolId: schoolB, role: 'school_admin', isSuperAdmin: false },
      (manager) => manager.query(`SELECT id FROM core.schools`),
    );

    expect(await resultA).toEqual([{ id: schoolA }]);
    expect(resultB).toEqual([{ id: schoolB }]);
  });
});
