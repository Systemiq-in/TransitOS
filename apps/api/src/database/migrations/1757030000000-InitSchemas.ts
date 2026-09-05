import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class InitSchemas1757030000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS core`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS audit`);

    // USAGE lets the app role reference objects in these schemas; it deliberately
    // gets no CREATE, so it can never add or alter tables.
    await queryRunner.query(`GRANT USAGE ON SCHEMA core TO ${appRole}`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA audit TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS audit CASCADE`);
    await queryRunner.query(`DROP SCHEMA IF EXISTS core CASCADE`);
  }
}
