import { Module } from '@nestjs/common';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SchoolsController],
  providers: [SchoolsService],
})
export class SchoolsModule {}
