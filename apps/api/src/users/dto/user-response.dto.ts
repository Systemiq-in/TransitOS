import { User, UserRole, UserStatus } from '../../entities/user.entity';

export interface UserResponseDto {
  id: string;
  schoolId: string | null;
  role: UserRole;
  email: string | null;
  phone: string | null;
  displayName: string;
  status: UserStatus;
}

export function toUserResponse(user: User): UserResponseDto {
  return {
    id: user.id,
    schoolId: user.schoolId,
    role: user.role,
    email: user.email,
    phone: user.phone,
    displayName: user.displayName,
    status: user.status,
  };
}
