import { validatePasswordPolicy } from './password-policy';

describe('validatePasswordPolicy', () => {
  it('accepts a password meeting every rule', () => {
    expect(validatePasswordPolicy('Correct-Horse9!')).toEqual([]);
  });

  it('flags a password shorter than 12 characters', () => {
    expect(validatePasswordPolicy('Sh0rt!')).toContain('must be at least 12 characters');
  });

  it('flags a password with no uppercase letter', () => {
    expect(validatePasswordPolicy('lowercase-only9!')).toContain(
      'must contain an uppercase letter',
    );
  });

  it('flags a password with no lowercase letter', () => {
    expect(validatePasswordPolicy('UPPERCASE-ONLY9!')).toContain(
      'must contain a lowercase letter',
    );
  });

  it('flags a password with no number', () => {
    expect(validatePasswordPolicy('NoNumbersHere!')).toContain('must contain a number');
  });

  it('flags a password with no symbol', () => {
    expect(validatePasswordPolicy('NoSymbolsHere9')).toContain('must contain a symbol');
  });

  it('flags a common password regardless of decoration', () => {
    expect(validatePasswordPolicy('Password123!')).toContain('is too common');
  });

  it('returns every violation for a password that fails multiple rules', () => {
    const violations = validatePasswordPolicy('short');
    expect(violations.length).toBeGreaterThan(1);
  });
});
