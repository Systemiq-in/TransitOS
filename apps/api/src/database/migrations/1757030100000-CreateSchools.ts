import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateSchools1757030100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE core.schools (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        locale text NOT NULL DEFAULT 'en-IN',
        timezone text NOT NULL DEFAULT 'Asia/Kolkata',
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // FORCE makes the policies apply to the table owner too, not just other roles.
    await queryRunner.query(`ALTER TABLE core.schools ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE core.schools FORCE ROW LEVEL SECURITY`);

    await queryRunner.query(`
      CREATE POLICY schools_super_admin_all ON core.schools
        FOR ALL
        USING (current_setting('app.is_super_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_super_admin', true) = 'true')
    `);

    // A school-scoped session may read its own row and nothing else — and may not
    // write here at all, since no INSERT/UPDATE policy matches it.
    await queryRunner.query(`
      CREATE POLICY schools_own_row_select ON core.schools
        FOR SELECT
        USING (id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
    `);

    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON core.schools TO ${appRole}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE core.schools`);
  }
}
