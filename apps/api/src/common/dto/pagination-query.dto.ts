import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_OFFSET = 0;

/**
 * Query-string pagination for list endpoints. `limit` above `MAX_LIMIT` is
 * rejected with 400 rather than silently clamped, so a client never believes
 * it received a full page when it did not.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(DEFAULT_OFFSET)
  offset: number = DEFAULT_OFFSET;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
