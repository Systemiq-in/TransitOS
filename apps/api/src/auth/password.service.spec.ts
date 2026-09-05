import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an Argon2id hash that is not the plaintext', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(hash).not.toBe('Correct-Horse9!');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifies a matching password', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(await service.verify(hash, 'Correct-Horse9!')).toBe(true);
  });

  it('rejects a non-matching password', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(await service.verify(hash, 'Wrong-Password9!')).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await service.hash('Correct-Horse9!');
    const b = await service.hash('Correct-Horse9!');
    expect(a).not.toBe(b);
  });

  it('pins the Argon2id parameters into the hash', async () => {
    const hash = await service.hash('Correct-Horse9!');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('verifyDummy() always resolves false, regardless of the input', async () => {
    expect(await service.verifyDummy('anything')).toBe(false);
    expect(await service.verifyDummy('')).toBe(false);
  });

  it('verifyDummy() computes the dummy hash only once across repeated calls', async () => {
    // A fresh instance, since the shared `service` above may already have a
    // cached dummy hash from an earlier test in this file.
    const freshService = new PasswordService();
    const hashSpy = jest.spyOn(freshService, 'hash');
    await freshService.verifyDummy('a');
    await freshService.verifyDummy('b');
    await freshService.verifyDummy('c');
    expect(hashSpy).toHaveBeenCalledTimes(1);
    hashSpy.mockRestore();
  });
});
