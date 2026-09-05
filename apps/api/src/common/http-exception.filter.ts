import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const rawMessage =
        typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      const message = Array.isArray(rawMessage) ? rawMessage.join(', ') : rawMessage;

      response.status(status).json({
        success: false,
        error: { code: HttpStatus[status] ?? 'ERROR', message },
      });
      return;
    }

    // Never surface a raw driver/ORM error (e.g. an RLS "permission denied") to the
    // client — log it server-side (left to your logging setup) and return a flat
    // generic message instead.
    response
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  }
}
