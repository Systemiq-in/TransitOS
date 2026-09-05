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

interface RotateClaimRow {
  user_id: string;
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

    // Atomic check-and-revoke: the validity predicate (unrevoked, unexpired,
    // matching fingerprint) rides on the same UPDATE that claims the token, so
    // two concurrent presentations of the same token cannot both read it as
    // valid and both walk away with a fresh pair. Whichever UPDATE commits
    // first claims the row (RETURNING a user_id); the other matches zero rows
    // and is rejected, regardless of which one issued the SELECT-then-UPDATE
    // read first — there is no separate read step to race.
    //
    // TypeORM's Postgres driver returns UPDATE results as a [rows, rowCount]
    // tuple from manager.query(), not the rows array directly — hence the
    // destructure below rather than treating the result itself as the row list.
    const [claimedRows] = await manager.query<[RotateClaimRow[], number]>(
      `UPDATE core.refresh_tokens
          SET revoked_at = now()
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()
          AND device_fingerprint = $2
        RETURNING user_id`,
      [hashToken(rawToken), fingerprint(deviceInfo)],
    );

    if (claimedRows.length === 0) {
      throw new Error('Refresh token is invalid, expired, revoked, or fingerprint mismatch');
    }

    const userId = claimedRows[0].user_id;
    const next = await this.issue(userId, deviceInfo);
    return { ...next, userId };
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
