import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSchoolUserDto } from './create-school-user.dto';

const VALID_BASE = {
  role: 'parent',
  password: 'Correct-Horse9!',
  displayName: 'A Parent',
};

const toDto = (overrides: Record<string, unknown>) =>
  plainToInstance(CreateSchoolUserDto, { ...VALID_BASE, ...overrides });

describe('CreateSchoolUserDto', () => {
  it('accepts a valid email', async () => {
    const errors = await validate(toDto({ email: 'parent@example.com' }));
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid E.164 phone number', async () => {
    const errors = await validate(toDto({ phone: '+14155552671' }));
    expect(errors).toHaveLength(0);
  });

  // I8: email and phone have independent UNIQUE constraints in core.users, and
  // AuthService.login now resolves a lookup value to exactly one of those
  // columns based on its shape. A phone-shaped value stored in the email
  // column would defeat that — it must be rejected here instead.
  it('rejects a phone-shaped value in the email field', async () => {
    const errors = await validate(toDto({ email: '+14155552671' }));
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects an email-shaped value in the phone field', async () => {
    const errors = await validate(toDto({ phone: 'parent@example.com' }));
    expect(errors.some((e) => e.property === 'phone')).toBe(true);
  });

  it('rejects a malformed phone number (missing leading +)', async () => {
    const errors = await validate(toDto({ phone: '14155552671' }));
    expect(errors.some((e) => e.property === 'phone')).toBe(true);
  });

  it('rejects a phone number over the max length', async () => {
    const errors = await validate(toDto({ phone: `+1${'4'.repeat(20)}` }));
    expect(errors.some((e) => e.property === 'phone')).toBe(true);
  });

  it('rejects an email over the max length', async () => {
    const longLocalPart = 'a'.repeat(250);
    const errors = await validate(toDto({ email: `${longLocalPart}@example.com` }));
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a displayName over the max length', async () => {
    const errors = await validate(toDto({ displayName: 'x'.repeat(201) }));
    expect(errors.some((e) => e.property === 'displayName')).toBe(true);
  });
});
