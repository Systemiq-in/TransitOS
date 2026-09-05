import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/app';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';

describe('Auth lifecycle (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let tenantContextService: TenantContextService;
  const passwordService = new PasswordService();

  // Ruling R7: /auth/login is throttled at 5 requests per 60 seconds, and this
  // suite performs roughly five logins in total — exactly the limit. The
  // throttler's storage is per application instance, so a fresh app (and a
  // fresh throttler window) per test avoids a flaky boundary. This is safe
  // because TenancyModule destroys its DataSource on shutdown (see Task 20),
  // so app.close() releases the connection pool cleanly each time.
  beforeEach(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    tenantContextService = new TenantContextService(dataSource);
  });

  afterEach(async () => {
    await app.close();
  });

  // Ruling R18: core.users.email is UNIQUE and the test database persists
  // between runs — every fixture email must be unique per run.
  function uniqueEmail(label: string): string {
    return `e2e-${label}-${randomUUID()}@example.com`;
  }

  // core.users has CONSTRAINT users_school_required — every non-super_admin row
  // needs a school_id. The brief's seedUser omits it; every fixture here is a
  // parent or school_admin, so a school must be created for each one.
  async function seedUser(email: string, role: string, password: string): Promise<void> {
    const hash = await passwordService.hash(password);
    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        let schoolId: string | null = null;
        if (role !== 'super_admin') {
          const [school] = await manager.query(
            `INSERT INTO core.schools (name) VALUES ('E2E Auth Lifecycle School') RETURNING id`,
          );
          schoolId = school.id;
        }
        await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES (${schoolId ? `'${schoolId}'` : 'NULL'}, '${role}', '${email}', '${hash}', 'E2E User')`,
        );
      },
    );
  }

  it('logs in, uses the access token, refreshes, logs out, and the old refresh token then fails', async () => {
    const email = uniqueEmail('parent');
    await seedUser(email, 'parent', 'Correct-Horse9!');

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: email, password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken, refreshToken } = login.body.data;

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    const newRefreshToken = refreshed.body.data.refreshToken;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
      .send({ refreshToken: newRefreshToken })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: newRefreshToken })
      .expect(401);
  });

  it('logout-all revokes a session opened from a different device', async () => {
    const email = uniqueEmail('two-device');
    await seedUser(email, 'parent', 'Correct-Horse9!');

    const deviceA = await request(app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'device-A')
      .send({ emailOrPhone: email, password: 'Correct-Horse9!' })
      .expect(201);
    const deviceB = await request(app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'device-B')
      .send({ emailOrPhone: email, password: 'Correct-Horse9!' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${deviceA.body.data.accessToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('User-Agent', 'device-B')
      .send({ refreshToken: deviceB.body.data.refreshToken })
      .expect(401);
  });

  it('requires MFA for a school_admin who has enrolled it, and rejects login without completing the challenge', async () => {
    const email = uniqueEmail('mfa-admin');
    await seedUser(email, 'school_admin', 'Correct-Horse9!');

    const preMfaLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: email, password: 'Correct-Horse9!' })
      .expect(201);
    const setupResponse = await request(app.getHttpServer())
      .post('/auth/mfa/setup')
      .set('Authorization', `Bearer ${preMfaLogin.body.data.accessToken}`)
      .expect(201);
    const { secret } = setupResponse.body.data;

    await request(app.getHttpServer())
      .post('/auth/mfa/confirm')
      .set('Authorization', `Bearer ${preMfaLogin.body.data.accessToken}`)
      .send({ totpCode: authenticator.generate(secret) })
      .expect(201);

    const secondLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: email, password: 'Correct-Horse9!' })
      .expect(201);
    expect(secondLogin.body.data.mfaRequired).toBe(true);

    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaChallengeToken: secondLogin.body.data.mfaChallengeToken, totpCode: '000000' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({
        mfaChallengeToken: secondLogin.body.data.mfaChallengeToken,
        totpCode: authenticator.generate(secret),
      })
      .expect(201);
  });
});
