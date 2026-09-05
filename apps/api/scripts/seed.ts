import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';
import { validatePasswordPolicy } from '../src/auth/password-policy';
import { User } from '../src/entities/user.entity';
import { appDataSourceOptions } from '../src/database/data-source';

export async function seedSuperAdmin(
  tenantContextService: TenantContextService,
  passwordService: PasswordService,
  input: { email: string; password: string },
): Promise<void> {
  const violations = validatePasswordPolicy(input.password);
  if (violations.length > 0) {
    throw new Error(`Seed password does not meet policy: ${violations.join(', ')}`);
  }

  await tenantContextService.runWithTenant(
    { sub: 'bootstrap', schoolId: null, role: 'super_admin', isSuperAdmin: true },
    async (manager) => {
      const repo = manager.getRepository(User);
      const existing = await repo.findOne({ where: { email: input.email } });
      if (existing) {
        return;
      }
      const passwordHash = await passwordService.hash(input.password);
      await repo.save({
        role: 'super_admin',
        email: input.email,
        passwordHash,
        displayName: 'Platform Super Admin',
      });
    },
  );
}

async function main(): Promise<void> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must both be set');
  }

  const dataSource = await new DataSource(appDataSourceOptions).initialize();
  const tenantContextService = new TenantContextService(dataSource);
  try {
    await seedSuperAdmin(tenantContextService, new PasswordService(), { email, password });
    console.log(`Super admin ready: ${email}`);
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
