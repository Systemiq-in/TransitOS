import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { AuditService } from '../audit/audit.service';
import { User, MFA_ELIGIBLE_ROLES } from '../entities/user.entity';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type LoginResult =
  | { mfaRequired: true; mfaChallengeToken: string }
  | ({ mfaRequired: false } & TokenPair);

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly mfaService: MfaService,
    private readonly auditService: AuditService,
  ) {}

  async login(
    input: { emailOrPhone: string; password: string },
    deviceInfo: string | null,
    ipAddress: string | null,
  ): Promise<LoginResult> {
    const manager = this.tenantContextService.getManager();
    const repo = manager.getRepository(User);

    // I8: resolve against exactly one column, chosen by the input's shape, rather
    // than an `OR` across both. core.users has independent UNIQUE constraints on
    // email and phone, so two different rows can each legitimately hold the same
    // string value in their own column; an unordered `OR ... getOne()` would then
    // pick between them non-deterministically instead of matching the column the
    // caller actually meant.
    const lookupColumn = input.emailOrPhone.includes('@') ? 'email' : 'phone';

    // The login carve-out RLS policy (see the CreateUsers migration) requires this
    // exact set_config, scoped to the connection this query runs on. Ruling R10:
    // reset it back to 'false' immediately after the lookup rather than leaving it
    // open for the rest of the request's transaction.
    await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['true']);
    const user = await repo
      .createQueryBuilder('u')
      .where(`u.${lookupColumn} = :value`, { value: input.emailOrPhone })
      .getOne();
    await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['false']);

    if (!user || user.status !== 'active') {
      // Finding 2: still perform an Argon2id comparison so this path costs
      // roughly the same as a wrong-password check on a real, active account —
      // otherwise the early return is a timing oracle for account enumeration.
      await this.passwordService.verifyDummy(input.password);
      throw new UnauthorizedException('Invalid credentials');
    }
    const passwordOk = await this.passwordService.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (MFA_ELIGIBLE_ROLES.includes(user.role) && (await this.mfaService.isEnabled(user.id))) {
      return { mfaRequired: true, mfaChallengeToken: this.tokenService.signMfaChallenge(user.id) };
    }

    return { mfaRequired: false, ...(await this.issueSession(user, deviceInfo, ipAddress)) };
  }

  async completeMfaChallenge(
    mfaChallengeToken: string,
    totpCode: string,
    deviceInfo: string | null,
    ipAddress: string | null,
  ): Promise<TokenPair> {
    // Ruling R6: TokenService throws a plain Error on an invalid/expired/wrong-purpose
    // token. Left unhandled that maps to a 500 via the global filter; translate to 401.
    let userId: string;
    try {
      ({ userId } = this.tokenService.verifyMfaChallenge(mfaChallengeToken));
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    }

    const codeOk = await this.mfaService.verifyCode(userId, totpCode);
    if (!codeOk) {
      throw new UnauthorizedException('Invalid MFA code');
    }

    const manager = this.tenantContextService.getManager();
    await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['true']);
    const user = await manager.getRepository(User).findOne({ where: { id: userId } });
    await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['false']);
    // Finding 1: a valid, unexpired challenge token proves nothing about the
    // account's *current* status — it was issued against the status at login
    // time. Re-check here so disabling an account during the challenge window
    // actually blocks the session it's meant to prevent.
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User no longer exists');
    }

    return this.issueSession(user, deviceInfo, ipAddress);
  }

  async refresh(rawToken: string, deviceInfo: string | null): Promise<TokenPair> {
    // Ruling R6: RefreshTokenService.rotate() throws a plain Error for every failure
    // mode (unknown, revoked, expired, fingerprint mismatch). Translate to a generic
    // 401 without revealing which case applied.
    let rotated: { rawToken: string; fingerprint: string; userId: string };
    try {
      rotated = await this.refreshTokenService.rotate(rawToken, deviceInfo);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const manager = this.tenantContextService.getManager();
    await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['true']);
    const user = await manager.getRepository(User).findOne({ where: { id: rotated.userId } });
    await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['false']);
    // Finding 1: without this, a disabled account keeps minting fresh access
    // tokens off its still-valid refresh token until that refresh token expires
    // (up to REFRESH_TOKEN_TTL_SECONDS later) — disabling wouldn't actually cut
    // the account off in any useful timeframe.
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User no longer exists');
    }

    return {
      accessToken: this.tokenService.signAccessToken({
        sub: user.id,
        schoolId: user.schoolId,
        role: user.role,
        isSuperAdmin: user.role === 'super_admin',
      }),
      refreshToken: rotated.rawToken,
    };
  }

  async logout(
    rawToken: string,
    actorUserId: string | undefined,
    schoolId: string | null = null,
  ): Promise<void> {
    await this.refreshTokenService.revoke(rawToken);
    await this.auditService.record({
      schoolId,
      actorUserId: actorUserId ?? null,
      action: 'user.logout',
    });
  }

  async logoutAll(userId: string, schoolId: string | null = null): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
    await this.auditService.record({
      schoolId,
      actorUserId: userId,
      action: 'user.logout_all',
    });
  }

  private async issueSession(
    user: User,
    deviceInfo: string | null,
    ipAddress: string | null,
  ): Promise<TokenPair> {
    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      schoolId: user.schoolId,
      role: user.role,
      isSuperAdmin: user.role === 'super_admin',
    });
    const { rawToken: refreshToken } = await this.refreshTokenService.issue(user.id, deviceInfo);

    await this.auditService.record({
      schoolId: user.schoolId,
      actorUserId: user.id,
      action: 'user.login',
      ipAddress,
    });

    return { accessToken, refreshToken };
  }
}
