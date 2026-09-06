import { MigrationInterface, QueryRunner } from 'typeorm';
import { validateEnv } from '../../config/env.schema';

export class CreateVehiclesAndStops1757030800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const appRole = validateEnv(process.env).APP_DB_ROLE;

    await queryRunner.query(`
      CREATE TABLE transport.vehicles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        registration_number text NOT NULL,
        capacity integer NOT NULL,
        ownership_type text NOT NULL DEFAULT 'school_owned',
        operator_name text,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vehicles_ownership_check
          CHECK (ownership_type IN ('school_owned', 'contracted', 'other')),
        CONSTRAINT vehicles_status_check CHECK (status IN ('active', 'maintenance', 'retired')),
        CONSTRAINT vehicles_capacity_check CHECK (capacity > 0),
        CONSTRAINT vehicles_registration_unique UNIQUE (school_id, registration_number)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE transport.stops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL REFERENCES core.schools(id),
        name text NOT NULL,
        latitude numeric(9,6) NOT NULL,
        longitude numeric(9,6) NOT NULL,
        geofence_radius_m integer NOT NULL DEFAULT 150,
        special_instructions text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stops_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT stops_longitude_check CHECK (longitude BETWEEN -180 AND 180),
        CONSTRAINT stops_geofence_check CHECK (geofence_radius_m > 0)
      )
    `);

    for (const table of ['vehicles', 'stops']) {
      await queryRunner.query(`CREATE INDEX ${table}_school_id_idx ON transport.${table} (school_id)`);
      await queryRunner.query(`ALTER TABLE transport.${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE transport.${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_all ON transport.${table}
          FOR ALL
          USING (
            current_setting('app.is_super_admin', true) = 'true'
            OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
          )
          WITH CHECK (
            current_setting('app.is_super_admin', true) = 'true'
            OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
          )
      `);
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON transport.${table} TO ${appRole}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS transport.stops`);
    await queryRunner.query(`DROP TABLE IF EXISTS transport.vehicles`);
  }
}
