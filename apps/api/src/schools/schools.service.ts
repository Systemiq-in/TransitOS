import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PasswordService } from '../auth/password.service';
import { validatePasswordPolicy } from '../auth/password-policy';
import { AuditService } from '../audit/audit.service';
import { School } from '../entities/school.entity';
import { User } from '../entities/user.entity';
import { PasswordHistory } from '../entities/password-history.entity';
import { CreateSchoolUserDto } from './dto/create-school-user.dto';

export interface Page<T> {
  items: T[];
  total: number;
}

@Injectable()
export class SchoolsService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly passwordService: PasswordService,
    private readonly auditService: AuditService,
  ) {}

  async create(name: string, actorUserId: string): Promise<School> {
    const manager = this.tenantContextService.getManager();
    const school = await manager.getRepository(School).save({ name });

    // C2: creating a tenant is a privileged operation and must be audited.
    await this.auditService.record({
      schoolId: school.id,
      actorUserId,
      action: 'school.created',
      entityType: 'school',
      entityId: school.id,
    });

    return school;
  }

  async findById(id: string): Promise<School | null> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(School).findOne({ where: { id } });
  }

  async findAll(limit: number, offset: number): Promise<Page<School>> {
    const manager = this.tenantContextService.getManager();
    const [items, total] = await manager.getRepository(School).findAndCount({
      take: limit,
      skip: offset,
      order: { createdAt: 'ASC' },
    });
    return { items, total };
  }

  async createUser(schoolId: string, input: CreateSchoolUserDto, actorUserId: string): Promise<User> {
    const violations = validatePasswordPolicy(input.password);
    if (violations.length > 0) {
      throw new BadRequestException(`Password does not meet policy: ${violations.join(', ')}`);
    }

    const manager = this.tenantContextService.getManager();
    const passwordHash = await this.passwordService.hash(input.password);

    const user = await manager.getRepository(User).save({
      schoolId,
      role: input.role,
      email: input.email ?? null,
      phone: input.phone ?? null,
      passwordHash,
      displayName: input.displayName,
    });

    await manager.getRepository(PasswordHistory).insert({ userId: user.id, passwordHash });

    // C2: creating a user is a privileged operation and must be audited.
    await this.auditService.record({
      schoolId,
      actorUserId,
      action: 'user.created',
      entityType: 'user',
      entityId: user.id,
    });

    return user;
  }

  async listUsers(schoolId: string, limit: number, offset: number): Promise<Page<User>> {
    const manager = this.tenantContextService.getManager();
    const [items, total] = await manager.getRepository(User).findAndCount({
      where: { schoolId },
      take: limit,
      skip: offset,
      order: { createdAt: 'ASC' },
    });
    return { items, total };
  }
}
