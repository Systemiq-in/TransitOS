import { IsOptional, IsString, Length } from 'class-validator';

export class MfaSetupDto {
  // I6: required only when the caller already has an enabled MFA credential —
  // MfaService enforces that, since it depends on database state the DTO layer
  // can't see.
  @IsOptional()
  @IsString()
  @Length(6, 6)
  currentTotpCode?: string;
}
