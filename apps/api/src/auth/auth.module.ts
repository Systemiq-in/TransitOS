import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';
import { MfaService } from './mfa.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, RefreshTokenService, MfaService],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
