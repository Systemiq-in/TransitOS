import { databaseNameFromUrl } from './bootstrap-db';

describe('databaseNameFromUrl', () => {
  it('extracts a normal database name from a connection URL', () => {
    expect(databaseNameFromUrl('postgres://user:pass@127.0.0.1:55432/transitos_test')).toBe(
      'transitos_test',
    );
  });

  it('throws when the name contains an embedded quote', () => {
    expect(() =>
      databaseNameFromUrl('postgres://user:pass@127.0.0.1:55432/evil%22name'),
    ).toThrow(/Refusing to use unsafe database name/);
  });

  it('throws when the name exceeds the 63-byte Postgres identifier cap', () => {
    const tooLong = 'a'.repeat(64);
    expect(() =>
      databaseNameFromUrl(`postgres://user:pass@127.0.0.1:55432/${tooLong}`),
    ).toThrow(/Refusing to use unsafe database name/);
  });
});
