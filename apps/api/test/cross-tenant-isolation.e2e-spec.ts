import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/app';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PasswordService } from '../src/auth/password.service';
import { SchoolsController } from '../src/schools/schools.controller';

// Only the controller's own `assertCanAccessSchool` check is neutralised below,
// via a prototype spy — never a real DB-level bypass. The type cast reaches
// past the method's `private` visibility, which TypeScript only enforces at
// compile time; jest.spyOn needs the runtime property regardless of who else
// can call it, and this file mocks nothing about the RLS session variables
// TenancyInterceptor sets from the caller's real JWT.
type ControllerWithGuard = { assertCanAccessSchool: (user: unknown, schoolId: string) => void };

describe('Cross-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let tenantContextService: TenantContextService;
  const passwordService = new PasswordService();
  let schoolA: string;
  let schoolB: string;
  // Ruling R18: core.users.email is UNIQUE and the test database persists
  // between runs — every fixture email must be unique per run.
  const adminAEmail = `isolation-admin-a-${randomUUID()}@example.com`;
  const parentBEmail = `isolation-parent-b-${randomUUID()}@example.com`;

  beforeAll(async () => {
    app = await createTestApp();
    const dataSource = app.get(DataSource);
    tenantContextService = new TenantContextService(dataSource);

    await tenantContextService.runWithTenant(
      { sub: 'seed', schoolId: null, role: 'super_admin', isSuperAdmin: true },
      async (manager) => {
        const [a] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('E2E Isolation School A') RETURNING id`,
        );
        const [b] = await manager.query(
          `INSERT INTO core.schools (name) VALUES ('E2E Isolation School B') RETURNING id`,
        );
        schoolA = a.id;
        schoolB = b.id;

        const hash = await passwordService.hash('Correct-Horse9!');
        await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ('${schoolA}', 'school_admin', '${adminAEmail}', '${hash}', 'Admin A')`,
        );
        await manager.query(
          `INSERT INTO core.users (school_id, role, email, password_hash, display_name)
           VALUES ('${schoolB}', 'parent', '${parentBEmail}', '${hash}', 'Parent B')`,
        );
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("does not let School A's admin read School B via the school detail endpoint", async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: adminAEmail, password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken } = login.body.data;

    await request(app.getHttpServer())
      .get(`/schools/${schoolB}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/schools/${schoolA}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it("does not let School A's admin list School B's users, even by targeting the URL directly", async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: adminAEmail, password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken } = login.body.data;

    const response = await request(app.getHttpServer())
      .get(`/schools/${schoolB}/users`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    expect(response.body.success).toBe(false);
  });

  it("does not let School A's admin create a user in School B", async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrPhone: adminAEmail, password: 'Correct-Horse9!' })
      .expect(201);
    const { accessToken } = login.body.data;

    await request(app.getHttpServer())
      .post(`/schools/${schoolB}/users`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        role: 'parent',
        email: 'sneaky@example.com',
        password: 'Correct-Horse9!',
        displayName: 'Sneaky',
      })
      .expect(403);
  });

  it('still isolates tenants at the RLS layer when the controller guard is bypassed', async () => {
    // Neutralise only the app-layer check — RLS, TenancyInterceptor, and the
    // guards are all still live and driven by a real JWT from a real login.
    const spy = jest
      .spyOn(SchoolsController.prototype as unknown as ControllerWithGuard, 'assertCanAccessSchool')
      .mockImplementation(() => undefined);

    try {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ emailOrPhone: adminAEmail, password: 'Correct-Horse9!' })
        .expect(201);
      const { accessToken } = login.body.data;

      // listUsers() never checks whether the school itself exists — it just
      // runs `WHERE school_id = schoolB` inside a transaction TenancyInterceptor
      // scoped to Admin A's own tenant (current_school_id = schoolA, from the
      // JWT). With the app-layer guard gone, RLS's `users_tenant_all` policy is
      // the only thing left: it ANDs `school_id = current_school_id` onto that
      // query, so the request still succeeds (the endpoint isn't a 404/403 kind
      // of failure at the RLS layer) but the result set is empty — School B's
      // own seeded user, Parent B, never appears.
      const response = await request(app.getHttpServer())
        .get(`/schools/${schoolB}/users`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.total).toBe(0);
      expect(response.body.data.items).toEqual([]);
      const emails = (response.body.data.items as Array<{ email: string }>).map((u) => u.email);
      expect(emails).not.toContain(parentBEmail);
    } finally {
      spy.mockRestore();
    }
  });
});
