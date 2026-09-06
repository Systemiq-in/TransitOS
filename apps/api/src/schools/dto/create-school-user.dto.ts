import { IsIn, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '../../entities/user.entity';

const ASSIGNABLE_ROLES: UserRole[] = ['school_admin', 'driver', 'attendant', 'parent'];

// I8: E.164-shaped (leading '+', no leading zero after it, 8-15 digits total).
// Deliberately disjoint from anything @IsEmail() would accept, so a value can
// never validate as both — that disjointness is what lets AuthService.login
// resolve a lookup value to exactly one column instead of guessing with an OR.
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export class CreateSchoolUserDto {
  @IsIn(ASSIGNABLE_ROLES)
  role: Exclude<UserRole, 'super_admin'>;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'phone must be in E.164 format (e.g. +14155552671)',
  })
  @MaxLength(16)
  phone?: string;

  @IsString()
  @MinLength(12)
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName: string;
}
