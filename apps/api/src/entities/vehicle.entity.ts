import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type VehicleOwnership = 'school_owned' | 'contracted' | 'other';
export type VehicleStatus = 'active' | 'maintenance' | 'retired';

@Entity({ schema: 'transport', name: 'vehicles' })
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @Column({ name: 'registration_number', type: 'text' })
  registrationNumber: string;

  @Column({ type: 'integer' })
  capacity: number;

  @Column({ name: 'ownership_type', type: 'text' })
  ownershipType: VehicleOwnership;

  @Column({ name: 'operator_name', type: 'text', nullable: true })
  operatorName: string | null;

  @Column({ type: 'text' })
  status: VehicleStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
