import { MigrationInterface, QueryRunner } from 'typeorm';

// I5: audit.audit_logs.actor_user_id was declared
// `REFERENCES core.users(id) ON DELETE SET NULL`, and the app role holds DELETE
// on core.users. A referential action runs with the referencing table's owner's
// privileges and bypasses row security, so deleting a user would silently null
// actor_user_id on every audit row that user generated — rewriting audit history
// without ever touching an UPDATE grant.
//
// Fixed to ON DELETE NO ACTION instead of dropping the FK outright: the column
// still only ever references a real user (or NULL for platform-level actions),
// and user removal in this system is already a soft delete
// (`status = 'disabled'`, already enforced on login/refresh/MFA) — so a hard
// DELETE of a user with attributed audit history should fail loudly, not
// silently erase the attribution.
export class FixAuditLogActorFk1757030500000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE audit.audit_logs DROP CONSTRAINT audit_logs_actor_user_id_fkey`,
    );
    await queryRunner.query(`
      ALTER TABLE audit.audit_logs
        ADD CONSTRAINT audit_logs_actor_user_id_fkey
        FOREIGN KEY (actor_user_id) REFERENCES core.users(id) ON DELETE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE audit.audit_logs DROP CONSTRAINT audit_logs_actor_user_id_fkey`,
    );
    await queryRunner.query(`
      ALTER TABLE audit.audit_logs
        ADD CONSTRAINT audit_logs_actor_user_id_fkey
        FOREIGN KEY (actor_user_id) REFERENCES core.users(id) ON DELETE SET NULL
    `);
  }
}
