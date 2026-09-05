import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessTokenClaims } from '../auth/token.service';
import { tenantContextStorage } from './tenant-context';

@Injectable()
export class TenantContextService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Runs `work` inside a transaction whose session variables reflect `claims`.
   * `claims === null` runs with no tenant/super-admin context at all — every RLS
   * policy that isn't the login carve-out or audit-log insert then sees nothing.
   */
  async runWithTenant<T>(
    claims: AccessTokenClaims | null,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `SET LOCAL app.is_super_admin = '${claims?.isSuperAdmin ? 'true' : 'false'}'`,
      );
      await queryRunner.query(`SET LOCAL app.current_school_id = '${claims?.schoolId ?? ''}'`);

      const result = await tenantContextStorage.run(queryRunner.manager, () =>
        work(queryRunner.manager),
      );

      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  getManager(): EntityManager {
    const manager = tenantContextStorage.getStore();
    if (!manager) {
      throw new Error(
        'TenantContextService.getManager() called outside runWithTenant() — ' +
          'every query must run inside a tenant-scoped transaction.',
      );
    }
    return manager;
  }
}
