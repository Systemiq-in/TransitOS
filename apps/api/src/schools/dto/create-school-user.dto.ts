import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '../../entities/user.entity';

const ASSIGNABLE_ROLES: UserRole[] = ['school_admin', 'driver', 'attendant', 'parent'];

export class CreateSchoolUserDto {
  @IsIn(ASSIGNABLE_ROLES)
  role: Exclude<UserRole, 'super_admin'>;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @MinLength(12)
  password: string;

  @IsString()
  @MinLength(1)
  displayName: string;
}
