import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { appDataSourceOptions } from '../database/data-source';
import { migrationDataSource } from '../database/data-source.migration';
import { Env } from '../config/env.schema';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://a:b@localhost/db',
  DATABASE_MIGRATION_URL: 'postgres://a:b@localhost/db',
  APP_DB_ROLE: 'transitos_app',
  APP_DB_PASSWORD: 'x',
  JWT_SECRET: 'a'.repeat(32),
  MFA_ENCRYPTION_KEY: '0'.repeat(64),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 604800,
  MFA_CHALLENGE_TTL_SECONDS: 300,
};
const configService = { get: (key: keyof Env) => testEnv[key] } as never;

// Ruling R18: core.users.email is UNIQUE and the test database persists across
// runs, so every email used here is namespaced by a fresh run id.
const runId = randomUUID();
const emailFor = (label: string) => `${label}-${runId}@example.com`;

describe('AuthService', () => {
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let refreshTokenService: RefreshTokenService;
  let mfaService: MfaService;
  let auditService: AuditService;
  let authService: AuthService;
  let schoolId: string;

  beforeAll(async () => {
    const migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    await migrator.destroy();

    dataSource = await new DataSource(appDataSourceOptions).initialize();
    tenantContextService = new TenantContextService(dataSource);
    passwordService = new PasswordService();
    tokenService = new TokenService(new JwtService(), configService);
    refreshTokenService = new RefreshTokenService(tenantContextService, configService);
    mfaService = new MfaService(tenantContextService, configService);
    auditService = new AuditService(tenantContextService);
    authService = new AuthService(
      tenantContextService,
      passwordService,
      tokenService,
      refreshTokenService,
      mfaService,
      auditService,
    );

    // The users_school_required check constraint requires a non-null school_id
    // for every role except super_admin, so every seeded user in this suite
    // (other than super_admin, unused here) needs a real school row to point at.
    schoolId = await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [school] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ($1) RETURNING id`,
          [`auth-service-test-${runId}`],
        );
        return school.id as string;
      },
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function createUser(email: string, role: string, password: string): Promise<string> {
    return tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const hash = await passwordService.hash(password);
        const [user] = await manager.query(
          `INSERT INTO core.users (role, school_id, email, password_hash, display_name)
           VALUES ($1, $2, $3, $4, 'Test User') RETURNING id`,
          [role, schoolId, email, hash],
        );
        return user.id;
      },
    );
  }

  it('logs in a driver (no MFA) directly with tokens', async () => {
    await createUser(emailFor('driver-a'), 'driver', 'Correct-Horse9!');

    const result = await tenantContextService.runWithTenant(null, () =>
      authService.login(
        { emailOrPhone: emailFor('driver-a'), password: 'Correct-Horse9!' },
        'device-A',
        '127.0.0.1',
      ),
    );

    expect(result.mfaRequired).toBe(false);
    if (!result.mfaRequired) {
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
    }
  });

  it('rejects a wrong password', async () => {
    await createUser(emailFor('driver-b'), 'driver', 'Correct-Horse9!');

    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.login(
          { emailOrPhone: emailFor('driver-b'), password: 'Wrong-Password9!' },
          'device-A',
          '127.0.0.1',
        ),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects login for an unknown account with the same generic error as a wrong password', async () => {
    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.login(
          { emailOrPhone: emailFor('does-not-exist'), password: 'Wrong-Password9!' },
          'device-A',
          '127.0.0.1',
        ),
      ),
    ).rejects.toThrow('Invalid credentials');
  });

  it('returns an MFA challenge for a school_admin with MFA enabled, then completes it', async () => {
    const email = emailFor('admin-mfa');
    const userId = await createUser(email, 'school_admin', 'Correct-Horse9!');
    const { secret } = await tenantContextService.runWithTenant(null, () =>
      mfaService.beginEnrollment(userId, email),
    );
    await tenantContextService.runWithTenant(null, () =>
      mfaService.confirmEnrollment(userId, authenticator.generate(secret)),
    );

    const loginResult = await tenantContextService.runWithTenant(null, () =>
      authService.login({ emailOrPhone: email, password: 'Correct-Horse9!' }, 'device-A', '127.0.0.1'),
    );
    expect(loginResult.mfaRequired).toBe(true);
    if (!loginResult.mfaRequired) throw new Error('expected an MFA challenge');
    expect((loginResult as { accessToken?: string }).accessToken).toBeUndefined();
    expect((loginResult as { refreshToken?: string }).refreshToken).toBeUndefined();

    const tokens = await tenantContextService.runWithTenant(null, () =>
      authService.completeMfaChallenge(
        loginResult.mfaChallengeToken,
        authenticator.generate(secret),
        'device-A',
        '127.0.0.1',
      ),
    );
    expect(tokens.accessToken).toEqual(expect.any(String));
    expect(tokens.refreshToken).toEqual(expect.any(String));
  });

  it('rejects a school_admin with MFA enabled logging in without a challenge bypass', async () => {
    const email = emailFor('admin-mfa-2');
    const userId = await createUser(email, 'school_admin', 'Correct-Horse9!');
    const { secret } = await tenantContextService.runWithTenant(null, () =>
      mfaService.beginEnrollment(userId, email),
    );
    await tenantContextService.runWithTenant(null, () =>
      mfaService.confirmEnrollment(userId, authenticator.generate(secret)),
    );

    const loginResult = await tenantContextService.runWithTenant(null, () =>
      authService.login({ emailOrPhone: email, password: 'Correct-Horse9!' }, 'device-A', '127.0.0.1'),
    );

    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.completeMfaChallenge(
          loginResult.mfaRequired ? loginResult.mfaChallengeToken : '',
          '000000',
          'device-A',
          '127.0.0.1',
        ),
      ),
    ).rejects.toThrow();
  });

  it('maps a garbage MFA challenge token to UnauthorizedException (R6), not an unhandled 500-prone Error', async () => {
    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.completeMfaChallenge('not-a-real-jwt', '000000', 'device-A', '127.0.0.1'),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('full lifecycle: login, refresh, logout, then refresh fails', async () => {
    await createUser(emailFor('lifecycle'), 'parent', 'Correct-Horse9!');

    const login = await tenantContextService.runWithTenant(null, () =>
      authService.login(
        { emailOrPhone: emailFor('lifecycle'), password: 'Correct-Horse9!' },
        'device-A',
        '127.0.0.1',
      ),
    );
    if (login.mfaRequired) throw new Error('unexpected mfa challenge');

    const refreshed = await tenantContextService.runWithTenant(null, () =>
      authService.refresh(login.refreshToken, 'device-A'),
    );

    await tenantContextService.runWithTenant(null, () =>
      authService.logout(refreshed.refreshToken, undefined),
    );

    await expect(
      tenantContextService.runWithTenant(null, () =>
        authService.refresh(refreshed.refreshToken, 'device-A'),
      ),
    ).rejects.toThrow();
  });

  it('maps a garbage refresh token to UnauthorizedException (R6), not an unhandled 500-prone Error', async () => {
    await expect(
      tenantContextService.runWithTenant(null, () => authService.refresh('garbage-token', 'device-A')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('logoutAll revokes every session for a user', async () => {
    const email = emailFor('logout-all');
    await createUser(email, 'parent', 'Correct-Horse9!');

    const first = await tenantContextService.runWithTenant(null, () =>
      authService.login({ emailOrPhone: email, password: 'Correct-Horse9!' }, 'device-A', '127.0.0.1'),
    );
    const second = await tenantContextService.runWithTenant(null, () =>
      authService.login({ emailOrPhone: email, password: 'Correct-Horse9!' }, 'device-B', '127.0.0.1'),
    );
    if (first.mfaRequired || second.mfaRequired) throw new Error('unexpected mfa challenge');

    const userId = await tenantContextService.runWithTenant(null, async (manager) => {
      await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['true']);
      const [row] = await manager.query(`SELECT id FROM core.users WHERE email = $1`, [email]);
      await manager.query(`SELECT set_config('app.auth_lookup', $1, true)`, ['false']);
      return row.id as string;
    });

    await tenantContextService.runWithTenant(null, () => authService.logoutAll(userId));

    await expect(
      tenantContextService.runWithTenant(null, () => authService.refresh(first.refreshToken, 'device-A')),
    ).rejects.toThrow();
    await expect(
      tenantContextService.runWithTenant(null, () => authService.refresh(second.refreshToken, 'device-B')),
    ).rejects.toThrow();
  });
});
