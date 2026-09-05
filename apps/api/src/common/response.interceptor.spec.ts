import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

describe('ResponseInterceptor', () => {
  it('wraps the handler result in a success envelope', async () => {
    const interceptor = new ResponseInterceptor();
    const handler: CallHandler = { handle: () => of({ id: 'abc' }) };
    const result = await firstValueFrom(interceptor.intercept({} as ExecutionContext, handler));
    expect(result).toEqual({ success: true, data: { id: 'abc' } });
  });
});
