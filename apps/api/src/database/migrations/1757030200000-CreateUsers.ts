import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateUsers1757030200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE core.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid REFERENCES core.schools(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (
          role IN ('super_admin', 'school_admin', 'driver', 'attendant', 'parent')
        ),
        email text UNIQUE,
        phone text UNIQUE,
        password_hash text NOT NULL,
        display_name text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_school_required CHECK (role = 'super_admin' OR school_id IS NOT NULL),
        CONSTRAINT users_contact_required CHECK (email IS NOT NULL OR phone IS NOT NULL)
      )
    `);
    await queryRunner.query(`CREATE INDEX users_school_id_idx ON core.users (school_id)`);

    await queryRunner.query(`ALTER TABLE core.users ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE core.users FORCE ROW LEVEL SECURITY`);

    await queryRunner.query(`
      CREATE POLICY users_super_admin_all ON core.users
        FOR ALL
        USING (current_setting('app.is_super_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_super_admin', true) = 'true')
    `);

    await queryRunner.query(`
      CREATE POLICY users_tenant_all ON core.users
        FOR ALL
        USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
        WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
    `);

    // The login carve-out. /auth/login must find a user by email or phone before any
    // tenant context can exist. SELECT only, and only when the credential-lookup
    // query explicitly sets the flag via SET LOCAL inside its own transaction.
    await queryRunner.query(`
      CREATE POLICY users_auth_lookup_select ON core.users
        FOR SELECT
        USING (current_setting('app.auth_lookup', true) = 'true')
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.users TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE core.users`);
  }
}
