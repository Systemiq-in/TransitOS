import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { Env } from '../config/env.schema';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { MfaCredential } from '../entities/mfa-credential.entity';
import { encryptSecret, decryptSecret } from '../crypto/secret-box';

const ISSUER = 'TransitOS';

@Injectable()
export class MfaService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async beginEnrollment(
    userId: string,
    accountLabel: string,
    currentTotpCode?: string,
  ): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(MfaCredential);
    const key = this.configService.get('MFA_ENCRYPTION_KEY');

    const existing = await repo.findOne({ where: { userId } });

    // I6: beginEnrollment used to overwrite the secret and reset enabledAt to
    // null unconditionally, so anyone holding a valid access token could silently
    // turn a super_admin's MFA off just by calling this endpoint. When a
    // credential is already enabled, require proof of the *current* secret
    // before replacing it, and never clear enabledAt here — it stays set for the
    // whole re-enrollment window, so login keeps demanding MFA throughout.
    if (existing?.enabledAt) {
      if (!currentTotpCode) {
        throw new UnauthorizedException(
          'Current TOTP code required to replace an active MFA credential',
        );
      }
      const currentSecret = decryptSecret(existing.secretEncrypted, key);
      if (!authenticator.check(currentTotpCode, currentSecret)) {
        throw new UnauthorizedException('Invalid current TOTP code');
      }
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    const encrypted = encryptSecret(secret, key);

    if (existing) {
      await repo.update(existing.id, { secretEncrypted: encrypted });
    } else {
      await repo.insert({ userId, secretEncrypted: encrypted, enabledAt: null });
    }

    return { secret, qrCodeDataUrl };
  }

  async confirmEnrollment(userId: string, totpCode: string): Promise<void> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(MfaCredential);
    const row = await repo.findOne({ where: { userId } });
    if (!row) {
      throw new Error('No MFA enrollment in progress for this user');
    }

    const secret = decryptSecret(row.secretEncrypted, this.configService.get('MFA_ENCRYPTION_KEY'));
    if (!authenticator.check(totpCode, secret)) {
      throw new Error('Invalid TOTP code');
    }

    await repo.update(row.id, { enabledAt: new Date() });
  }

  async isEnabled(userId: string): Promise<boolean> {
    const manager = this.tenantContextService.getManager();
    const row = await manager.getRepository(MfaCredential).findOne({ where: { userId } });
    return Boolean(row?.enabledAt);
  }

  async verifyCode(userId: string, totpCode: string): Promise<boolean> {
    const manager = this.tenantContextService.getManager();
    const row = await manager.getRepository(MfaCredential).findOne({ where: { userId } });
    if (!row?.enabledAt) {
      return false;
    }
    const secret = decryptSecret(row.secretEncrypted, this.configService.get('MFA_ENCRYPTION_KEY'));
    return authenticator.check(totpCode, secret);
  }
}
