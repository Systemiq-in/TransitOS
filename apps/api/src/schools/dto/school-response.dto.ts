import { School } from '../../entities/school.entity';

export interface SchoolResponseDto {
  id: string;
  name: string;
  locale: string;
  timezone: string;
  status: string;
}

export function toSchoolResponse(school: School): SchoolResponseDto {
  return {
    id: school.id,
    name: school.name,
    locale: school.locale,
    timezone: school.timezone,
    status: school.status,
  };
}
