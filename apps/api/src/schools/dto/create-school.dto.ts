import { IsString, MinLength } from 'class-validator';

export class CreateSchoolDto {
  @IsString()
  @MinLength(2)
  name: string;
}
