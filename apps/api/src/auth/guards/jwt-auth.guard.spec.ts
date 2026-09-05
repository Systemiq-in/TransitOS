import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from '../token.service';

function buildContext(authHeader?: string): ExecutionContext {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authHeader ? { authorization: authHeader } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('allows a route marked @Public() through without a token', () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector, {} as TokenService);
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it('rejects a protected route with no Authorization header', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector, {} as TokenService);
    expect(() => guard.canActivate(buildContext())).toThrow(UnauthorizedException);
  });

  it('rejects a protected route with an invalid token', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const tokenService = {
      verifyAccessToken: () => {
        throw new Error('bad token');
      },
    } as unknown as TokenService;
    const guard = new JwtAuthGuard(reflector, tokenService);
    expect(() => guard.canActivate(buildContext('Bearer bad-token'))).toThrow(UnauthorizedException);
  });

  it('attaches claims to request.user on a valid token', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const claims = { sub: 'u1', schoolId: 's1', role: 'school_admin', isSuperAdmin: false };
    const tokenService = { verifyAccessToken: () => claims } as unknown as TokenService;
    const guard = new JwtAuthGuard(reflector, tokenService);
    const context = buildContext('Bearer good-token');

    expect(guard.canActivate(context)).toBe(true);
    expect(context.switchToHttp().getRequest().user).toEqual(claims);
  });
});
