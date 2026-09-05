import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenancyModule } from './tenancy.module';

describe('TenancyModule shutdown', () => {
  it('destroys the DataSource (releasing its pg pool) when the app is closed', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TenancyModule] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    const dataSource = app.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);

    await app.close();

    expect(dataSource.isInitialized).toBe(false);
  });
});
