import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

interface RequestWithUser extends Request {
  user?: { sub?: string };
}

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

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

    // C4: never surface a raw driver/ORM error (e.g. an RLS "permission denied")
    // to the client, but do log it server-side — this is the only trace of an
    // unhandled 500 that will ever exist. Never log the request body, headers,
    // or any token: only the method, path, the caller's subject if the request
    // was authenticated, and the error's own message/stack.
    const request = host.switchToHttp().getRequest<RequestWithUser>();
    const error = exception instanceof Error ? exception : new Error(String(exception));
    const context = [
      request?.method ?? 'UNKNOWN',
      request?.path ?? request?.url ?? 'UNKNOWN',
      request?.user?.sub ? `user=${request.user.sub}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    this.logger.error(`Unhandled exception on ${context}: ${error.message}`, error.stack);

    response
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  }
}
