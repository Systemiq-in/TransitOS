import { Request } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';

// C1: req.ip can be undefined (no `trust proxy` behind an ingress, a unix
// socket, some supertest setups). The old code fell back to the literal string
// 'unknown', which is not valid Postgres `inet` input and 500s the whole login
// path once it reaches AuditService.record(). The fallback must be `null` — the
// column is nullable — never a placeholder string.
describe('AuthController ip fallback (C1)', () => {
  function buildController() {
    const authService = {
      login: jest.fn().mockResolvedValue({ mfaRequired: false, accessToken: 'a', refreshToken: 'r' }),
      completeMfaChallenge: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    } as unknown as AuthService;
    const mfaService = {} as MfaService;
    const controller = new AuthController(authService, mfaService);
    return { controller, authService };
  }

  function fakeRequest(ip: string | undefined): Request {
    return { ip, headers: {} } as unknown as Request;
  }

  it('passes null (not the string "unknown") to authService.login when req.ip is undefined', async () => {
    const { controller, authService } = buildController();

    await controller.login({ emailOrPhone: 'user@example.com', password: 'x' }, fakeRequest(undefined));

    expect(authService.login).toHaveBeenCalledWith(
      { emailOrPhone: 'user@example.com', password: 'x' },
      null,
      null,
    );
  });

  it('passes the real ip through unchanged when req.ip is set', async () => {
    const { controller, authService } = buildController();

    await controller.login({ emailOrPhone: 'user@example.com', password: 'x' }, fakeRequest('127.0.0.1'));

    expect(authService.login).toHaveBeenCalledWith(
      { emailOrPhone: 'user@example.com', password: 'x' },
      null,
      '127.0.0.1',
    );
  });

  it('passes null (not "unknown") to completeMfaChallenge when req.ip is undefined', async () => {
    const { controller, authService } = buildController();

    await controller.mfaVerify({ mfaChallengeToken: 't', totpCode: '000000' }, fakeRequest(undefined));

    expect(authService.completeMfaChallenge).toHaveBeenCalledWith('t', '000000', null, null);
  });
});
