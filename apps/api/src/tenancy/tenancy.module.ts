import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
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
export class TenancyModule implements OnApplicationShutdown {
  constructor(private readonly dataSource: DataSource) {}

  // TypeORM's DataSource implements neither OnModuleDestroy nor
  // OnApplicationShutdown, so without this hook app.close() would never
  // release the underlying pg connection pool.
  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
