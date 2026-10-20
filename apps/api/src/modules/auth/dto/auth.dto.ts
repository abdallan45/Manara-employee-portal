import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ChangePasswordInput } from '@workforce/shared';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from '../password';

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString() @Length(1, 64)
  username!: string;

  @ApiProperty({ format: 'password' })
  @IsString() @Length(1, 256)
  password!: string;

  @ApiPropertyOptional({ enum: ['WEB', 'MOBILE'], default: 'WEB', description: 'WEB gets cookies + CSRF token; MOBILE gets a bearer token' })
  @IsOptional() @IsIn(['WEB', 'MOBILE'])
  client?: 'WEB' | 'MOBILE';
}

export class DemoLoginDto {
  @ApiProperty({ example: 'manager' })
  @IsString() @Length(1, 64)
  username!: string;
}

export class LocaleDto {
  @ApiProperty({ enum: ['en', 'ar'] })
  @IsIn(['en', 'ar'])
  locale!: 'en' | 'ar';
}

export class ChangePasswordDto implements ChangePasswordInput {
  @ApiProperty({ format: 'password' })
  @IsString() @Length(1, 256)
  currentPassword!: string;

  @ApiProperty({ format: 'password', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString() @Length(PASSWORD_MIN, PASSWORD_MAX)
  newPassword!: string;
}
