import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 25 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize: number = 25;
}

export const pageArgs = (q: PaginationQueryDto) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
