import { COMMON_PASSWORDS, normalizeForCommonCheck } from './common-passwords';

const MIN_LENGTH = 12;

export function validatePasswordPolicy(password: string): string[] {
  const violations: string[] = [];

  if (password.length < MIN_LENGTH) {
    violations.push(`must be at least ${MIN_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) {
    violations.push('must contain an uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    violations.push('must contain a lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    violations.push('must contain a number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    violations.push('must contain a symbol');
  }
  if (COMMON_PASSWORDS.has(normalizeForCommonCheck(password))) {
    violations.push('is too common');
  }

  return violations;
}
