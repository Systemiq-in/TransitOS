import { ArgumentsHost, BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalHttpExceptionFilter } from './http-exception.filter';

function buildHost(request: Record<string, unknown> = { method: 'GET', path: '/things' }) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('GlobalHttpExceptionFilter', () => {
  // Keeps the real Logger.prototype.error (exercised by every non-HttpException
  // test in this file, including ones outside the C4 describe block below) from
  // printing to the test runner's console.
  let quietErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    quietErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    quietErrorSpy.mockRestore();
  });

  it('maps a NestJS HttpException to a structured error envelope', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, status, json } = buildHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'bad input' },
    });
  });

  it('normalizes ValidationPipe array messages to a joined string', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, status, json } = buildHost();

    // ValidationPipe throws BadRequestException with message: string[]
    const exception = new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: ['email must be an email', 'age must be a number'],
    });

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'email must be an email, age must be a number' },
    });
  });

  it('preserves 401 status for UnauthorizedException', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, status, json } = buildHost();

    filter.catch(new UnauthorizedException('invalid token'), host);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'invalid token' },
    });
  });

  it('maps an unrecognized error to a generic 500 without leaking internals', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, status, json } = buildHost();

    filter.catch(new QueryFailedError('SELECT 1', [], new Error('permission denied for table x')), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
  });

  // C4: nothing in the application logged anything, ever — every 500 vanished
  // with no server-side trace.
  describe('server-side logging (C4)', () => {
    // Reuses the outer beforeEach's spy — it's the same Logger.prototype.error.
    const errorSpy = () => quietErrorSpy;

    it('logs an unhandled (non-HttpException) error at error level, with method, path, and the stack', () => {
      const filter = new GlobalHttpExceptionFilter();
      const { host } = buildHost({ method: 'POST', path: '/auth/login' });
      const error = new QueryFailedError('SELECT 1', [], new Error('permission denied for table x'));

      filter.catch(error, host);

      expect(errorSpy()).toHaveBeenCalledTimes(1);
      const [message, stack] = errorSpy().mock.calls[0];
      expect(message).toEqual(expect.stringContaining('POST'));
      expect(message).toEqual(expect.stringContaining('/auth/login'));
      expect(typeof stack).toBe('string');
    });

    it('includes request.user.sub when the request was authenticated', () => {
      const filter = new GlobalHttpExceptionFilter();
      const { host } = buildHost({
        method: 'POST',
        path: '/schools',
        user: { sub: 'user-123' },
      });

      filter.catch(new Error('boom'), host);

      const [message] = errorSpy().mock.calls[0];
      expect(message).toEqual(expect.stringContaining('user-123'));
    });

    it('never logs the request body, headers, or a token', () => {
      const filter = new GlobalHttpExceptionFilter();
      const { host } = buildHost({
        method: 'POST',
        path: '/auth/login',
        headers: { authorization: 'Bearer super-secret-token' },
        body: { password: 'hunter2' },
      });

      filter.catch(new Error('boom'), host);

      const loggedText = errorSpy().mock.calls.flat().join(' ');
      expect(loggedText).not.toContain('super-secret-token');
      expect(loggedText).not.toContain('hunter2');
    });

    it('does not log anything for a handled HttpException', () => {
      const filter = new GlobalHttpExceptionFilter();
      const { host } = buildHost();

      filter.catch(new BadRequestException('bad input'), host);

      expect(errorSpy()).not.toHaveBeenCalled();
    });
  });
});
