import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('core.schools RLS', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let schoolB: string;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();

    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);
    const [a] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('Greenwood Academy') RETURNING id`,
    );
    const [b] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('Springfield School') RETURNING id`,
    );
    schoolA = a.id;
    schoolB = b.id;
    await runner.commitTransaction();
    await runner.release();
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('shows a school-scoped session only its own school row', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'false'`);
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);

    const rows = await runner.query(
      `SELECT id FROM core.schools WHERE id IN ('${schoolA}','${schoolB}')`,
    );

    await runner.rollbackTransaction();
    await runner.release();

    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([schoolA].sort());
  });

  it('shows a super_admin session every school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);

    const rows = await runner.query(
      `SELECT id FROM core.schools WHERE id IN ('${schoolA}','${schoolB}')`,
    );

    await runner.rollbackTransaction();
    await runner.release();

    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([schoolA, schoolB].sort());
  });

  it('shows nothing at all when no tenant context has been set', async () => {
    const rows = await app.query(`SELECT id FROM core.schools`);
    expect(rows).toHaveLength(0);
  });

  it('refuses to let a school-scoped session insert a new school', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'false'`);
    await runner.query(`SET LOCAL app.current_school_id = '${schoolA}'`);

    await expect(
      runner.query(`INSERT INTO core.schools (name) VALUES ('Rogue School')`),
    ).rejects.toThrow(/row-level security/i);

    await runner.rollbackTransaction();
    await runner.release();
  });
});
