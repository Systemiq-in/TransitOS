import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, firstValueFrom, from } from 'rxjs';
import { AccessTokenClaims } from '../auth/token.service';
import { TenantContextService } from './tenant-context.service';

@Injectable()
export class TenancyInterceptor implements NestInterceptor {
  constructor(private readonly tenantContextService: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ user?: AccessTokenClaims }>();
    const claims = request.user ?? null;

    return from(
      this.tenantContextService.runWithTenant(claims, () => firstValueFrom(next.handle())),
    );
  }
}
