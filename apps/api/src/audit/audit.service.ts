import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';

export interface AuditEntry {
  schoolId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly tenantContextService: TenantContextService) {}

  async record(entry: AuditEntry): Promise<void> {
    const manager = this.tenantContextService.getManager();
    const metadata = entry.metadata ?? {};
    await manager.query(
      `INSERT INTO audit.audit_logs (school_id, actor_user_id, action, entity_type, entity_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.schoolId,
        entry.actorUserId,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.ipAddress ?? null,
        JSON.stringify(metadata),
      ],
    );
  }
}
