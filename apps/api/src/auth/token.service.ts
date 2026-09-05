import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Env } from '../config/env.schema';
import { UserRole } from '../entities/user.entity';

export interface AccessTokenClaims {
  sub: string;
  schoolId: string | null;
  role: UserRole;
  isSuperAdmin: boolean;
}

interface MfaChallengeClaims {
  sub: string;
  purpose: 'mfa-challenge';
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwtService.sign(
      { ...claims, purpose: 'access' },
      {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: this.configService.get('ACCESS_TOKEN_TTL_SECONDS'),
      },
    );
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const payload = this.jwtService.verify<AccessTokenClaims & { purpose?: string }>(token, {
      secret: this.configService.get('JWT_SECRET'),
    });
    if (payload.purpose !== 'access') {
      throw new Error('Not an access token');
    }
    return {
      sub: payload.sub,
      schoolId: payload.schoolId,
      role: payload.role,
      isSuperAdmin: payload.isSuperAdmin,
    };
  }

  signMfaChallenge(userId: string): string {
    const claims: MfaChallengeClaims = { sub: userId, purpose: 'mfa-challenge' };
    return this.jwtService.sign(claims, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: this.configService.get('MFA_CHALLENGE_TTL_SECONDS'),
    });
  }

  verifyMfaChallenge(token: string): { userId: string } {
    const claims = this.jwtService.verify<MfaChallengeClaims>(token, {
      secret: this.configService.get('JWT_SECRET'),
    });
    if (claims.purpose !== 'mfa-challenge') {
      throw new Error('Not an MFA challenge token');
    }
    return { userId: claims.sub };
  }
}
