import { encryptSecret, decryptSecret } from './secret-box';

const key = '0'.repeat(64);
const otherKey = '1'.repeat(64);

describe('secret-box', () => {
  it('round-trips a plaintext string', () => {
    const ciphertext = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(decryptSecret(ciphertext, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces different ciphertext for the same plaintext each call (random IV)', () => {
    const a = encryptSecret('same-secret', key);
    const b = encryptSecret('same-secret', key);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(() => decryptSecret(ciphertext, otherKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext (auth tag check)', () => {
    const payload = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const lastByte = parseInt(payload.slice(-2), 16);
    const flipped = (lastByte ^ 0xff).toString(16).padStart(2, '0');
    const tampered = payload.slice(0, -2) + flipped;

    expect(tampered).not.toBe(payload);
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
