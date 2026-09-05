import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateAuthTables1757030300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE core.refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        device_fingerprint text NOT NULL,
        device_info text,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX refresh_tokens_user_id_idx ON core.refresh_tokens (user_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE core.password_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX password_history_user_id_idx ON core.password_history (user_id, created_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE core.mfa_credentials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE REFERENCES core.users(id) ON DELETE CASCADE,
        secret_encrypted text NOT NULL,
        enabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON core.refresh_tokens, core.password_history, core.mfa_credentials TO ${appRole}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE core.mfa_credentials`);
    await queryRunner.query(`DROP TABLE core.password_history`);
    await queryRunner.query(`DROP TABLE core.refresh_tokens`);
  }
}
