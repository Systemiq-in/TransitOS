import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { RefreshToken } from '../entities/refresh-token.entity';

/**
 * Derives a best-effort device fingerprint from client-supplied data (the
 * user-agent / device info string). This is defence in depth, not hardware
 * attestation: it raises the cost of replaying a stolen token from a
 * different client, but does nothing against an attacker who forges
 * matching headers.
 */
export function fingerprint(deviceInfo: string | null): string {
  return createHash('sha256').update(deviceInfo ?? 'unknown-device').digest('hex');
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async issue(
    userId: string,
    deviceInfo: string | null,
  ): Promise<{ rawToken: string; fingerprint: string }> {
    const rawToken = randomBytes(32).toString('hex');
    const ttlSeconds = this.configService.get('REFRESH_TOKEN_TTL_SECONDS');
    const manager = this.tenantContextService.getManager();

    await manager.getRepository(RefreshToken).insert({
      userId,
      tokenHash: hashToken(rawToken),
      deviceFingerprint: fingerprint(deviceInfo),
      deviceInfo,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });

    return { rawToken, fingerprint: fingerprint(deviceInfo) };
  }

  async rotate(
    rawToken: string,
    deviceInfo: string | null,
  ): Promise<{ rawToken: string; fingerprint: string; userId: string }> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(RefreshToken);
    const row = await repo.findOne({ where: { tokenHash: hashToken(rawToken) } });

    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new Error('Refresh token is invalid, expired, or revoked');
    }
    if (row.deviceFingerprint !== fingerprint(deviceInfo)) {
      throw new Error('Refresh token device fingerprint mismatch');
    }

    await repo.update(row.id, { revokedAt: new Date() });
    const next = await this.issue(row.userId, deviceInfo);
    return { ...next, userId: row.userId };
  }

  async revoke(rawToken: string): Promise<void> {
    const manager = this.tenantContextService.getManager();
    await manager
      .getRepository(RefreshToken)
      .update({ tokenHash: hashToken(rawToken) }, { revokedAt: new Date() });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const manager = this.tenantContextService.getManager();
    await manager
      .getRepository(RefreshToken)
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }
}
