import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

const toDto = (query: Record<string, string>) =>
  plainToInstance(PaginationQueryDto, query, { enableImplicitConversion: false });

describe('PaginationQueryDto', () => {
  it('defaults limit to 50 and offset to 0 when neither is given', async () => {
    const dto = toDto({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
    expect(dto.offset).toBe(0);
  });

  it('accepts a limit at the maximum of 200', async () => {
    const dto = toDto({ limit: '200' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(200);
  });

  it('rejects a limit above the maximum of 200', async () => {
    const dto = toDto({ limit: '201' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('rejects a limit below the minimum of 1', async () => {
    const dto = toDto({ limit: '0' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('rejects a negative offset', async () => {
    const dto = toDto({ offset: '-1' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('offset');
  });

  it('coerces numeric query strings to numbers', async () => {
    const dto = toDto({ limit: '10', offset: '5' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(10);
    expect(dto.offset).toBe(5);
  });
});
