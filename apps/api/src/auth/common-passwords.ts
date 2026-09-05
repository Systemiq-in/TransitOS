export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  [
    'password', 'password1', 'password123', '123456', '123456789', 'qwerty',
    'letmein', 'welcome', 'admin123', 'iloveyou', 'monkey123', 'dragon123',
  ].map((p) => p.toLowerCase()),
);

/** Strips common decoration (digits, symbols) so "Password123!" still matches "password". */
export function normalizeForCommonCheck(password: string): string {
  return password.toLowerCase().replace(/[^a-z]/g, '');
}
