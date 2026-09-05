import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';
import { Env } from '../config/env.schema';

function buildService(overrides: Partial<Env> = {}): TokenService {
  const env: Env = {
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
    ...overrides,
  };
  const configService = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  return new TokenService(new JwtService(), configService);
}

describe('TokenService', () => {
  it('round-trips access token claims', () => {
    const service = buildService();
    const token = service.signAccessToken({
      sub: 'user-1',
      schoolId: 'school-1',
      role: 'school_admin',
      isSuperAdmin: false,
    });
    expect(service.verifyAccessToken(token)).toMatchObject({
      sub: 'user-1',
      schoolId: 'school-1',
      role: 'school_admin',
      isSuperAdmin: false,
    });
  });

  it('rejects a token signed with a different secret', () => {
    const service = buildService();
    const otherService = buildService({ JWT_SECRET: 'b'.repeat(32) });
    const token = otherService.signAccessToken({
      sub: 'user-1',
      schoolId: null,
      role: 'super_admin',
      isSuperAdmin: true,
    });
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it('rejects an expired access token', () => {
    const service = buildService({ ACCESS_TOKEN_TTL_SECONDS: -1 });
    const token = service.signAccessToken({
      sub: 'user-1',
      schoolId: null,
      role: 'super_admin',
      isSuperAdmin: true,
    });
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it('round-trips an MFA challenge token', () => {
    const service = buildService();
    const token = service.signMfaChallenge('user-1');
    expect(service.verifyMfaChallenge(token)).toEqual({ userId: 'user-1' });
  });

  it('rejects an access token presented as an MFA challenge token', () => {
    const service = buildService();
    const accessToken = service.signAccessToken({
      sub: 'user-1',
      schoolId: null,
      role: 'super_admin',
      isSuperAdmin: true,
    });
    expect(() => service.verifyMfaChallenge(accessToken)).toThrow();
  });

  it('rejects an MFA challenge token presented as an access token', () => {
    const service = buildService();
    const challenge = service.signMfaChallenge('user-1');
    expect(() => service.verifyAccessToken(challenge)).toThrow();
  });
});
