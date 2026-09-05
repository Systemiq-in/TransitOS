import { Controller, Get, NotFoundException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../auth/token.service';
import { UsersService } from './users.service';
import { toUserResponse, UserResponseDto } from './dto/user-response.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async me(@CurrentUser() claims: AccessTokenClaims): Promise<UserResponseDto> {
    const user = await this.usersService.findById(claims.sub);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toUserResponse(user);
  }
}
