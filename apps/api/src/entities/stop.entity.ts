import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'transport', name: 'stops' })
export class Stop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ type: 'text' })
  name: string;

  // numeric(9,6) is returned by pg as a string to preserve precision;
  // the response DTO converts it for the wire.
  @Column({ type: 'numeric', precision: 9, scale: 6 })
  latitude: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  longitude: string;

  @Column({ name: 'geofence_radius_m', type: 'integer' })
  geofenceRadiusM: number;

  @Column({ name: 'special_instructions', type: 'text', nullable: true })
  specialInstructions: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
