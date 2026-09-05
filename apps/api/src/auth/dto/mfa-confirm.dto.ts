import { IsString, Length } from 'class-validator';

export class MfaConfirmDto {
  @IsString()
  @Length(6, 6)
  totpCode: string;
}
