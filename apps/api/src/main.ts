import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import { AppModule } from './app.module';
import { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Must be called before listen(): TenancyModule's shutdown hook (destroying
  // the pg connection pool) never fires on SIGTERM in production without this —
  // it only ran in tests because they call app.close() explicitly.
  app.enableShutdownHooks();
  app.use(compression());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const configService: ConfigService<Env, true> = app.get(ConfigService);
  await app.listen(configService.get('PORT'));
}

void bootstrap();
