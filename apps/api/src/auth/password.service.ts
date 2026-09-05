import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
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
}
