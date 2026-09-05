import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  /**
   * A hash of a random value, computed once and cached. Verifying a login attempt
   * against this on a "no such user" (or "account inactive") path costs the same
   * Argon2id work as a real comparison, closing a timing oracle that would
   * otherwise let an attacker distinguish a wrong password from a nonexistent
   * account by how long the response takes.
   */
  private dummyHashPromise: Promise<string> | null = null;

  /**
   * Pinned explicitly rather than inheriting library defaults, which have changed across argon2
   * releases and would otherwise shift this system's security and latency profile silently on a
   * dependency bump. Argon2 encodes its parameters in the PHC hash string, so these can be
   * retuned later without rehashing existing passwords.
   */
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MiB — memory hardness is the primary defence
      timeCost: 3,
      parallelism: 1, // one lane per hash: less thread-pool pressure than the default p=4
    });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    return argon2.verify(hash, plain);
  }

  /**
   * Performs an Argon2id verify against a fixed, never-matching dummy hash, using
   * the exact same parameters as `hash()`. Callers use this on a login path where
   * no real password hash exists to compare against (unknown or inactive account),
   * so that path takes comparable time to a real verify instead of returning early.
   * Always resolves to `false`.
   */
  async verifyDummy(plain: string): Promise<boolean> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.hash(randomUUID());
    }
    const dummyHash = await this.dummyHashPromise;
    return this.verify(dummyHash, plain);
  }
}
