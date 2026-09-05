import { Global, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { appDataSourceOptions } from '../database/data-source';
import { TenantContextService } from './tenant-context.service';
import { TenancyInterceptor } from './tenancy.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: async () => new DataSource(appDataSourceOptions).initialize(),
    },
    TenantContextService,
    TenancyInterceptor,
  ],
  exports: [TenantContextService, TenancyInterceptor],
})
export class TenancyModule {}
