import { ArgumentsHost, BadRequestException } from '@nestjs/common';
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
