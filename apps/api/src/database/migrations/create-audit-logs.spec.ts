import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('audit.audit_logs immutability and visibility', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;

  // Unique per run so this persistent test database can be re-run without the
  // audit table's growth (it is append-only and never truncated) affecting any
  // assertion below — every read here is scoped to this run's fresh schoolA.
  const runId = randomUUID();
  const action = `user.login-${runId}`;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    [{ id: schoolA }] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('Audited School ${runId}') RETURNING id`,
    );
    await runner.commitTransaction();
    await runner.release();

    // Writes are always permitted, with or without tenant context — a login has to
    // be auditable before the caller is authenticated.
    await app.query(
      `INSERT INTO audit.audit_logs (school_id, action) VALUES ('${schoolA}', '${action}')`,
    );
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('refuses UPDATE from the application role', async () => {
    await expect(
      app.query(`UPDATE audit.audit_logs SET action = 'tampered' WHERE school_id = '${schoolA}'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses DELETE from the application role', async () => {
    await expect(
      app.query(`DELETE FROM audit.audit_logs WHERE school_id = '${schoolA}'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('shows a school-scoped session only its own audit rows', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);
    const rows = await runner.query(`SELECT action FROM audit.audit_logs`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([{ action }]);
  });

  it('hides audit rows from a session scoped to a different school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.current_school_id = '00000000-0000-0000-0000-000000000000'`);
    const rows = await runner.query(
      `SELECT action FROM audit.audit_logs WHERE action = '${action}'`,
    );
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([]);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'false'`);
    await runner.query(`SET LOCAL app.current_school_id = ''`);
    const rows = await runner.query(
      `SELECT action FROM audit.audit_logs WHERE action = '${action}'`,
    );
    await runner.rollbackTransaction();
    await runner.release();

    expect(rows).toEqual([]);
  });
});
