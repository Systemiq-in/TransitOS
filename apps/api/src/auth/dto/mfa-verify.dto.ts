import { IsString, Length } from 'class-validator';

export class MfaVerifyDto {
  @IsString()
  mfaChallengeToken: string;

  @IsString()
  @Length(6, 6)
  totpCode: string;
}
