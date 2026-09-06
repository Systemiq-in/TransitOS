import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

// I5: this is the finding the reviewer derived from PostgreSQL's documented
// behaviour (a referential action runs with the referencing table's owner's
// privileges and bypasses row security) rather than an executed delete — this
// test is what actually confirms the fix. Before the fix, ON DELETE SET NULL
// would let the app role's own DELETE grant on core.users silently null out
// actor_user_id on every audit row that user generated. After the fix
// (ON DELETE NO ACTION), that same DELETE must fail outright, leaving the
// audit row's attribution untouched.
describe('audit.audit_logs actor_user_id FK survives actor deletion (I5)', () => {
  let migrator: DataSource;
  let app: DataSource;
  const runId = randomUUID();

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it("deleting the actor as the app role fails, and the audit row's actor_user_id is unchanged", async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SET LOCAL app.is_super_admin = 'true'`);

    const [school] = await runner.query(
      `INSERT INTO core.schools (name) VALUES ('I5 Fk Test School ${runId}') RETURNING id`,
    );
    const [user] = await runner.query(
      `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
       VALUES ($1, 'parent', $2, 'hash', 'I5 Fk Test User') RETURNING id`,
      [school.id, `i5-fk-test-${runId}@example.com`],
    );
    const [auditLog] = await runner.query(
      `INSERT INTO audit.audit_logs (school_id, actor_user_id, action)
       VALUES ($1, $2, 'user.login') RETURNING id`,
      [school.id, user.id],
    );

    // The app role genuinely holds DELETE on core.users (see CreateUsers
    // migration) and is_super_admin bypasses the RLS check above, so this
    // attempt reaches the FK constraint itself, not an earlier permission
    // check. A failed statement aborts the rest of the transaction in Postgres,
    // so wrap it in a SAVEPOINT to keep asserting afterward within the same
    // transaction.
    await runner.query(`SAVEPOINT before_delete`);
    await expect(runner.query(`DELETE FROM core.users WHERE id = $1`, [user.id])).rejects.toThrow(
      /violates foreign key constraint/i,
    );
    await runner.query(`ROLLBACK TO SAVEPOINT before_delete`);

    const [row] = await runner.query(`SELECT actor_user_id FROM audit.audit_logs WHERE id = $1`, [
      auditLog.id,
    ]);
    expect(row.actor_user_id).toBe(user.id);

    const [stillThere] = await runner.query(`SELECT id FROM core.users WHERE id = $1`, [user.id]);
    expect(stillThere).toBeDefined();

    await runner.rollbackTransaction();
    await runner.release();
  });
});
