import { migrationDataSource } from '../src/database/data-source.migration';

export default async function globalSetup(): Promise<void> {
  const dataSource = await migrationDataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
