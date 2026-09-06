import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { migrationDataSource } from '../data-source.migration';
import { appDataSourceOptions } from '../data-source';

describe('CreateVehiclesAndStops migration', () => {
  let migrator: DataSource;
  let app: DataSource;
  let schoolA: string;
  let schoolB: string;

  const asSuperAdmin = async <T>(fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['true']);
    try {
      const result = await fn((sql, p) => runner.query(sql, p));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  const asTenant = async (schoolId: string, sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    try {
      await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
      await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, [schoolId]);
      const rows = (await runner.query(sql, params)) as unknown[];
      await runner.rollbackTransaction();
      return rows;
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    migrator = await migrationDataSource.initialize();
    await migrator.runMigrations();
    app = await new DataSource(appDataSourceOptions).initialize();
    await asSuperAdmin(async (q) => {
      const s = (await q(`INSERT INTO core.schools (name) VALUES ('V-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolA = s[0].id;
      const b = (await q(`INSERT INTO core.schools (name) VALUES ('W-${randomUUID()}') RETURNING id`)) as { id: string }[];
      schoolB = b[0].id;
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await migrator?.destroy();
  });

  it('stores a contracted vehicle with its operator', async () => {
    const rows = (await asSuperAdmin(async (q) =>
      q(
        `INSERT INTO transport.vehicles (school_id, registration_number, capacity, ownership_type, operator_name)
         VALUES ($1, $2, 36, 'contracted', 'Kerala Travels') RETURNING ownership_type, operator_name`,
        [schoolA, `KL-07-${randomUUID().slice(0, 6)}`],
      ),
    )) as { ownership_type: string; operator_name: string }[];
    expect(rows[0]).toEqual({ ownership_type: 'contracted', operator_name: 'Kerala Travels' });
  });

  it('rejects an unknown ownership type', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.vehicles (school_id, registration_number, capacity, ownership_type)
           VALUES ($1, $2, 36, 'leased')`,
          [schoolA, `KL-08-${randomUUID().slice(0, 6)}`],
        ),
      ),
    ).rejects.toThrow(/vehicles_ownership_check/i);
  });

  it('stores a stop with coordinates and a default geofence radius', async () => {
    const rows = (await asSuperAdmin(async (q) =>
      q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude)
         VALUES ($1, $2, 10.026400, 76.308100) RETURNING latitude, longitude, geofence_radius_m`,
        [schoolA, `Edappally-${randomUUID().slice(0, 6)}`],
      ),
    )) as { latitude: string; longitude: string; geofence_radius_m: number }[];
    expect(Number(rows[0].latitude)).toBeCloseTo(10.0264, 4);
    expect(Number(rows[0].longitude)).toBeCloseTo(76.3081, 4);
    expect(rows[0].geofence_radius_m).toBe(150);
  });

  // Note: a genuine Kerala lat/lon transposition (e.g. 76.3081, 10.0264) would NOT
  // violate stops_latitude_check, because Kerala's longitude magnitude (~76) is
  // still within the latitude column's [-90, 90] range even when swapped in. This
  // fixture uses a longitude whose magnitude exceeds 90 so the transposed value
  // actually trips the check — otherwise this test would pass even with no
  // constraint at all.
  it('rejects a transposed coordinate pair', async () => {
    await expect(
      asSuperAdmin(async (q) =>
        q(
          `INSERT INTO transport.stops (school_id, name, latitude, longitude)
           VALUES ($1, $2, 176.308100, 10.026400)`,
          [schoolA, `Bad-${randomUUID().slice(0, 6)}`],
        ),
      ),
    ).rejects.toThrow(/stops_latitude_check/i);
  });

  it('allows a tenant session to read its own school vehicles and stops', async () => {
    const registration = `KL-09-${randomUUID().slice(0, 6)}`;
    const stopName = `Kakkanad-${randomUUID().slice(0, 6)}`;
    await asSuperAdmin(async (q) => {
      await q(
        `INSERT INTO transport.vehicles (school_id, registration_number, capacity) VALUES ($1, $2, 40)`,
        [schoolA, registration],
      );
      await q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude) VALUES ($1, $2, 10.0159, 76.3419)`,
        [schoolA, stopName],
      );
    });

    const vehicles = await asTenant(
      schoolA,
      `SELECT id FROM transport.vehicles WHERE registration_number = $1`,
      [registration],
    );
    const stops = await asTenant(schoolA, `SELECT id FROM transport.stops WHERE name = $1`, [stopName]);

    expect(vehicles).toHaveLength(1);
    expect(stops).toHaveLength(1);
  });

  it('hides one school vehicles from another school session', async () => {
    const registration = `KL-10-${randomUUID().slice(0, 6)}`;
    await asSuperAdmin(async (q) => {
      await q(
        `INSERT INTO transport.vehicles (school_id, registration_number, capacity) VALUES ($1, $2, 40)`,
        [schoolA, registration],
      );
    });

    const rows = await asTenant(
      schoolB,
      `SELECT id FROM transport.vehicles WHERE registration_number = $1`,
      [registration],
    );
    expect(rows).toEqual([]);
  });

  it('hides one school stops from another school session', async () => {
    const stopName = `Aluva-${randomUUID().slice(0, 6)}`;
    await asSuperAdmin(async (q) => {
      await q(
        `INSERT INTO transport.stops (school_id, name, latitude, longitude) VALUES ($1, $2, 10.1075, 76.3516)`,
        [schoolA, stopName],
      );
    });

    const rows = await asTenant(schoolB, `SELECT id FROM transport.stops WHERE name = $1`, [stopName]);
    expect(rows).toEqual([]);
  });

  it('denies access without erroring when the tenant context is an empty string', async () => {
    const runner = app.createQueryRunner();
    await runner.startTransaction();
    await runner.query(`SELECT set_config('app.is_super_admin', $1, true)`, ['false']);
    await runner.query(`SELECT set_config('app.current_school_id', $1, true)`, ['']);
    const vehicles = await runner.query(`SELECT id FROM transport.vehicles`);
    const stops = await runner.query(`SELECT id FROM transport.stops`);
    await runner.rollbackTransaction();
    await runner.release();

    expect(vehicles).toEqual([]);
    expect(stops).toEqual([]);
  });
});
