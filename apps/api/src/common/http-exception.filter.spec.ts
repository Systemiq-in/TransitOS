import { ArgumentsHost, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalHttpExceptionFilter } from './http-exception.filter';

function buildHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('GlobalHttpExceptionFilter', () => {
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
});
