import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';

describe('AppModule wiring', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('responds to /healthz wrapped in the success envelope', async () => {
    const response = await request(app.getHttpServer()).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('responds 401 for a protected route with no token, in the error envelope', async () => {
    const response = await request(app.getHttpServer()).get('/users/me');
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('rate-limits repeated login attempts', async () => {
    const attempts = Array.from({ length: 7 }, () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ emailOrPhone: 'nobody@example.com', password: 'wrong-password-1!' }),
    );
    const responses = await Promise.all(attempts);
    expect(responses.some((r) => r.status === 429)).toBe(true);
  });
});
