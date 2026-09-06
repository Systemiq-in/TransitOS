import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../auth/token.service';
import { toUserResponse, UserResponseDto } from '../users/dto/user-response.dto';
import { PaginatedResponse, PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { SchoolsService } from './schools.service';
import { CreateSchoolDto } from './dto/create-school.dto';
import { CreateSchoolUserDto } from './dto/create-school-user.dto';
import { SchoolResponseDto, toSchoolResponse } from './dto/school-response.dto';

@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  // A regular (non-arrow) instance method — not a free function — so that a
  // test can neutralise it via `jest.spyOn(SchoolsController.prototype, ...)`
  // without replacing the whole controller, to prove RLS is a real backstop
  // and not merely a second copy of this same check.
  /** Throws unless the caller is a super_admin or the school_admin of exactly this school. */
  private assertCanAccessSchool(user: AccessTokenClaims, schoolId: string): void {
    if (user.role === 'super_admin') return;
    if (user.role === 'school_admin' && user.schoolId === schoolId) return;
    throw new ForbiddenException('You do not have permission to access this school');
  }

  @Roles('super_admin')
  @Post()
  async create(
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateSchoolDto,
  ): Promise<SchoolResponseDto> {
    const school = await this.schoolsService.create(dto.name, user.sub);
    return toSchoolResponse(school);
  }

  @Roles('super_admin')
  @Get()
  async findAll(
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<SchoolResponseDto>> {
    const { items, total } = await this.schoolsService.findAll(
      pagination.limit,
      pagination.offset,
    );
    return {
      items: items.map(toSchoolResponse),
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  @Roles('super_admin', 'school_admin')
  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<SchoolResponseDto> {
    this.assertCanAccessSchool(user, id);
    const school = await this.schoolsService.findById(id);
    if (!school) {
      throw new NotFoundException('School not found');
    }
    return toSchoolResponse(school);
  }

  @Roles('super_admin', 'school_admin')
  @Post(':id/users')
  async createUser(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() dto: CreateSchoolUserDto,
  ): Promise<UserResponseDto> {
    this.assertCanAccessSchool(user, id);
    const created = await this.schoolsService.createUser(id, dto, user.sub);
    return toUserResponse(created);
  }

  @Roles('super_admin', 'school_admin')
  @Get(':id/users')
  async listUsers(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<UserResponseDto>> {
    this.assertCanAccessSchool(user, id);
    const { items, total } = await this.schoolsService.listUsers(
      id,
      pagination.limit,
      pagination.offset,
    );
    return {
      items: items.map(toUserResponse),
      total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }
}
