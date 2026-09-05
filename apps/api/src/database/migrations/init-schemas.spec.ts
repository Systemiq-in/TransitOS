import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('InitSchemas migration', () => {
  let migrator: DataSource;
  let app: DataSource;

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('creates the core and audit schemas', async () => {
    const rows = await migrator.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('core','audit') ORDER BY schema_name`,
    );
    expect(rows.map((r: { schema_name: string }) => r.schema_name)).toEqual(['audit', 'core']);
  });

  it('enables pgcrypto so gen_random_uuid() is available', async () => {
    const [row] = await migrator.query(`SELECT gen_random_uuid() AS id`);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lets the app role connect and use both schemas', async () => {
    const [row] = await app.query(`SELECT current_user AS role`);
    expect(row.role).toBe(process.env.APP_DB_ROLE);
  });

  it('does not grant the app role permission to create tables in core', async () => {
    const [row] = await app.query(
      `SELECT has_schema_privilege(current_user, 'core', 'CREATE') AS can_create`,
    );
    expect(row.can_create).toBe(false);
  });
});
