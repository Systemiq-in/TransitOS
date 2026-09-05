import { Injectable } from '@nestjs/common';
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
  ): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(MfaCredential);
    const encrypted = encryptSecret(secret, this.configService.get('MFA_ENCRYPTION_KEY'));

    const existing = await repo.findOne({ where: { userId } });
    if (existing) {
      await repo.update(existing.id, { secretEncrypted: encrypted, enabledAt: null });
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
