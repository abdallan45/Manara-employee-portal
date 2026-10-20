import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: 'Liveness + database check' })
  async health(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ok' | 'degraded'; database: 'up' | 'down'; time: string }> {
    let database: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: database === 'up' ? 'ok' : 'degraded', database, time: new Date().toISOString() };
  }
}
