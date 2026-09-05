import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SchoolStatus = 'active' | 'suspended';

@Entity({ schema: 'core', name: 'schools' })
export class School {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: 'en-IN' })
  locale: string;

  @Column({ type: 'text', default: 'Asia/Kolkata' })
  timezone: string;

  @Column({ type: 'text', default: 'active' })
  status: SchoolStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
