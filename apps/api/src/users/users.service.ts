import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { User } from '../entities/user.entity';

@Injectable()
export class UsersService {
  constructor(private readonly tenantContextService: TenantContextService) {}

  async findById(id: string): Promise<User | null> {
    const manager = this.tenantContextService.getManager();
    return manager.getRepository(User).findOne({ where: { id } });
  }
}
