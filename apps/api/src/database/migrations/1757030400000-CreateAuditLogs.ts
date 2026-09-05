import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateAuditLogs1757030400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE audit.audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid,
        actor_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
        action text NOT NULL,
        entity_type text,
        entity_id uuid,
        ip_address inet,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX audit_logs_school_created_idx ON audit.audit_logs (school_id, created_at DESC)`,
    );

    await queryRunner.query(`ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE audit.audit_logs FORCE ROW LEVEL SECURITY`);

    // Writes are unconditional: an audit record must be capturable during login,
    // before any tenant context exists. Reads are tenant-scoped.
    await queryRunner.query(`
      CREATE POLICY audit_logs_insert_any ON audit.audit_logs
        FOR INSERT WITH CHECK (true)
    `);
    await queryRunner.query(`
      CREATE POLICY audit_logs_super_admin_select ON audit.audit_logs
        FOR SELECT USING (current_setting('app.is_super_admin', true) = 'true')
    `);
    await queryRunner.query(`
      CREATE POLICY audit_logs_tenant_select ON audit.audit_logs
        FOR SELECT
        USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
    `);

    // The heart of immutability: the app role is never granted UPDATE or DELETE, so
    // tampering fails at the privilege check, not at a policy or in application code.
    await queryRunner.query(`GRANT SELECT, INSERT ON audit.audit_logs TO ${appRole}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE audit.audit_logs`);
  }
}
