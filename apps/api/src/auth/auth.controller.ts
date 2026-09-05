import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import { AccessTokenClaims } from './token.service';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { LoginDto } from './dto/login.dto';
import { MfaVerifyDto } from './dto/mfa-verify.dto';
import { MfaConfirmDto } from './dto/mfa-confirm.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';

function deviceInfoOf(req: Request): string | null {
  return req.headers['user-agent'] ?? null;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfaService: MfaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, deviceInfoOf(req), req.ip ?? 'unknown');
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  mfaVerify(@Body() dto: MfaVerifyDto, @Req() req: Request) {
    return this.authService.completeMfaChallenge(
      dto.mfaChallengeToken,
      dto.totpCode,
      deviceInfoOf(req),
      req.ip ?? 'unknown',
    );
  }

  @Roles('super_admin', 'school_admin')
  @Post('mfa/setup')
  mfaSetup(@CurrentUser() user: AccessTokenClaims) {
    return this.mfaService.beginEnrollment(user.sub, user.sub);
  }

  @Roles('super_admin', 'school_admin')
  @Post('mfa/confirm')
  mfaConfirm(@CurrentUser() user: AccessTokenClaims, @Body() dto: MfaConfirmDto) {
    return this.mfaService.confirmEnrollment(user.sub, dto.totpCode);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, deviceInfoOf(req));
  }

  @Post('logout')
  logout(@CurrentUser() user: AccessTokenClaims, @Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken, user.sub);
  }

  @Post('logout-all')
  logoutAll(@CurrentUser() user: AccessTokenClaims) {
    return this.authService.logoutAll(user.sub);
  }
}
