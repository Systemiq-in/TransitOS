import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('core.users RLS', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let schoolB: string;

  // Unique per run so this persistent test database can be re-run without colliding
  // with the UNIQUE constraint on core.users.email.
  const runId = randomUUID();
  const adminAEmail = `admin-a-${runId}@example.com`;
  const adminBEmail = `admin-b-${runId}@example.com`;
  const sneakyEmail = `sneaky-${runId}@example.com`;
  const orphanEmail = `orphan-${runId}@example.com`;

  const asSuperAdmin = async <T>(fn: (q: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    try {
      return await fn((sql: string) => runner.query(sql));
    } finally {
      await runner.commitTransaction();
      await runner.release();
    }
  };

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    await asSuperAdmin(async (q) => {
      [{ id: schoolA }] = (await q(
        `INSERT INTO core.schools (name) VALUES ('School A') RETURNING id`,
      )) as { id: string }[];
      [{ id: schoolB }] = (await q(
        `INSERT INTO core.schools (name) VALUES ('School B') RETURNING id`,
      )) as { id: string }[];
      await q(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
               VALUES ('${schoolA}', 'school_admin', '${adminAEmail}', 'hash', 'Admin A')`);
      await q(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
               VALUES ('${schoolB}', 'school_admin', '${adminBEmail}', 'hash', 'Admin B')`);
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('shows a school-scoped session only its own school users', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);
    const rows = await runner.query(
      `SELECT email FROM core.users WHERE email IN ('${adminAEmail}', '${adminBEmail}')`,
    );
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows.map((r: { email: string }) => r.email)).toEqual([adminAEmail]);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'false'`);
    await runner.query(`SET LOCAL app.current_school_id = ''`);

    const rows = await runner.query(
      `SELECT email FROM core.users WHERE email IN ('${adminAEmail}', '${adminBEmail}')`,
    );

    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([]);
  });

  it('rejects a school-scoped session inserting a user into another school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);

    await expect(
      runner.query(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
                    VALUES ('${schoolB}', 'parent', '${sneakyEmail}', 'hash', 'Sneaky')`),
    ).rejects.toThrow(/row-level security/i);

    await runner.rollbackTransaction();
    await runner.release();
  });

  it('allows a credential lookup with app.auth_lookup set, with no tenant context', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.auth_lookup = 'true'`);
    const rows = await runner.query(
      `SELECT id, role FROM core.users WHERE email = '${adminBEmail}'`,
    );
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('school_admin');
  });

  it('grants the auth lookup flag no write power whatsoever', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.auth_lookup = 'true'`);

    // No UPDATE policy matches an auth-lookup session (the tenant policy's USING
    // clause requires a school_id match, and no tenant context is set here), so the
    // row is invisible to the write. That can surface either as a silent zero-row
    // update or as an outright RLS violation error -- both are acceptable proof
    // that the flag grants no write power. Assert whichever the database actually
    // does, then prove it semantically by re-reading the row under a fresh
    // super_admin context and confirming it was never actually changed.
    let updateThrew = false;
    try {
      await runner.query(
        `UPDATE core.users SET role = 'super_admin' WHERE email = '${adminBEmail}'`,
      );
    } catch {
      updateThrew = true;
    }

    if (updateThrew) {
      await runner.rollbackTransaction();
    } else {
      await runner.commitTransaction();
    }
    await runner.release();

    const role = await asSuperAdmin(async (q) => {
      const rows = (await q(
        `SELECT role FROM core.users WHERE email = '${adminBEmail}'`,
      )) as { role: string }[];
      return rows[0].role;
    });

    expect(role).toBe('school_admin');
  });

  it('enforces that only super_admin users may have a null school_id', async () => {
    await expect(
      asSuperAdmin((q) =>
        q(`INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES (NULL, 'parent', '${orphanEmail}', 'hash', 'Orphan')`),
      ),
    ).rejects.toThrow(/users_school_required/);
  });
});
