import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { TenancyInterceptor } from './tenancy.interceptor';
import { TenantContextService } from './tenant-context.service';

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenancyInterceptor', () => {
  it('runs the handler inside runWithTenant using request.user as claims', async () => {
    const runWithTenant = jest.fn((_claims, work) => work({} as never));
    const tenantContextService = { runWithTenant } as unknown as TenantContextService;
    const interceptor = new TenancyInterceptor(tenantContextService);

    const claims = { sub: 'u1', schoolId: 's1', role: 'school_admin', isSuperAdmin: false };
    const handler: CallHandler = { handle: () => of('result') };

    const result = await firstValueFrom(interceptor.intercept(buildContext(claims), handler));

    expect(result).toBe('result');
    expect(runWithTenant).toHaveBeenCalledWith(claims, expect.any(Function));
  });

  it('passes null claims through for an unauthenticated (public) route', async () => {
    const runWithTenant = jest.fn((_claims, work) => work({} as never));
    const tenantContextService = { runWithTenant } as unknown as TenantContextService;
    const interceptor = new TenancyInterceptor(tenantContextService);
    const handler: CallHandler = { handle: () => of('result') };

    await firstValueFrom(interceptor.intercept(buildContext(undefined), handler));

    expect(runWithTenant).toHaveBeenCalledWith(null, expect.any(Function));
  });
});
