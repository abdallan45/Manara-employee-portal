import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min, ValidateIf,
  ValidateNested, registerDecorator, type ValidationArguments, type ValidationOptions,
} from 'class-validator';
import {
  isMascotTime, MASCOT_LANGUAGES, MASCOT_MOODS, MASCOT_TRIGGERS, type MascotArrival, type MascotLanguage, type MascotConditions, type MascotGroupInput,
  type MascotLineInput, type MascotLocale, type MascotMood, type MascotTrigger,
} from '@workforce/shared';

const ARRIVALS: readonly MascotArrival[] = ['EARLY', 'ON_TIME', 'LATE'];
const LOCALES: readonly MascotLocale[] = ['ar', 'en'];
/** Present in the body (null included); for PATCH fields that must not be cleared. */
const present = (_: object, v: unknown) => v !== undefined;

function IsMascotTime(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isMascotTime', target: object.constructor, propertyName, options,
    validator: {
      validate: (v: unknown) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) && isMascotTime(v),
      defaultMessage: (a: ValidationArguments) => `${a.property} must be a time "HH:mm" between 00:00 and 23:59`,
    },
  });
}

/** min ≤ max when both are set. */
function MinNotAboveMax(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'minNotAboveMax', target: object.constructor, propertyName, options,
    validator: {
      validate: (_: unknown, a: ValidationArguments) => {
        const o = a.object as { min?: number; max?: number };
        return typeof o.min !== 'number' || typeof o.max !== 'number' || o.min <= o.max;
      },
      defaultMessage: () => 'min must not be greater than max',
    },
  });
}

export class MascotWorkVsRequiredDto {
  @ApiPropertyOptional({ minimum: -1440, maximum: 1440 })
  @IsOptional() @IsInt() @Min(-1440) @Max(1440) @MinNotAboveMax()
  min?: number;

  @ApiPropertyOptional({ minimum: -1440, maximum: 1440 })
  @IsOptional() @IsInt() @Min(-1440) @Max(1440)
  max?: number;
}

const CODE_LIST = { each: true } as const;

export class MascotConditionsDto implements MascotConditions {
  @ApiPropertyOptional({ example: '06:00' }) @IsOptional() @IsMascotTime() timeFrom?: string;
  @ApiPropertyOptional({ example: '12:00' }) @IsOptional() @IsMascotTime() timeTo?: string;

  @ApiPropertyOptional({ type: [Number], description: '0 = Sunday … 6 = Saturday' })
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ArrayUnique() @IsInt(CODE_LIST) @Min(0, CODE_LIST) @Max(6, CODE_LIST)
  weekdays?: number[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() workday?: boolean;

  @ApiPropertyOptional({ enum: ARRIVALS, isArray: true })
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ArrayUnique() @IsIn(ARRIVALS, CODE_LIST)
  arrival?: MascotArrival[];

  @ApiPropertyOptional({ example: '08:00' }) @IsOptional() @IsMascotTime() earlyBefore?: string;

  @ApiPropertyOptional({ type: MascotWorkVsRequiredDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => MascotWorkVsRequiredDto)
  workVsRequired?: MascotWorkVsRequiredDto;

  @ApiPropertyOptional({ type: [String], example: ['LUNCH'] })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsString(CODE_LIST) @Length(1, 40, CODE_LIST)
  breakTypeCodes?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() breakExceeded?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['LOCATION_OUTSIDE_OFFICE'] })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsString(CODE_LIST) @Length(1, 40, CODE_LIST)
  errorCodes?: string[];
}

export class CreateMascotGroupDto implements MascotGroupInput {
  @ApiProperty({ example: 'ترحيب الصبح' }) @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 500) description?: string | null;
  @ApiProperty({ enum: MASCOT_TRIGGERS }) @IsIn(MASCOT_TRIGGERS) trigger!: MascotTrigger;

  @ApiPropertyOptional({ type: MascotConditionsDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => MascotConditionsDto)
  conditions?: MascotConditionsDto;

  @ApiPropertyOptional({ minimum: -100, maximum: 100 }) @IsOptional() @IsInt() @Min(-100) @Max(100) priority?: number;

  @ApiPropertyOptional({ enum: MASCOT_MOODS, isArray: true })
  @IsOptional() @IsArray() @ArrayMaxSize(MASCOT_MOODS.length) @ArrayUnique() @IsIn(MASCOT_MOODS, CODE_LIST)
  moods?: MascotMood[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(-100000) @Max(100000) sortOrder?: number;
}

export class UpdateMascotGroupDto implements Partial<MascotGroupInput> {
  @ApiPropertyOptional() @ValidateIf(present) @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 500) description?: string | null;
  @ApiPropertyOptional({ enum: MASCOT_TRIGGERS }) @ValidateIf(present) @IsIn(MASCOT_TRIGGERS) trigger?: MascotTrigger;

  @ApiPropertyOptional({ type: MascotConditionsDto, description: 'Replaces the whole conditions object' })
  @ValidateIf(present) @IsObject() @ValidateNested() @Type(() => MascotConditionsDto)
  conditions?: MascotConditionsDto;

  @ApiPropertyOptional({ minimum: -100, maximum: 100 }) @ValidateIf(present) @IsInt() @Min(-100) @Max(100) priority?: number;

  @ApiPropertyOptional({ enum: MASCOT_MOODS, isArray: true })
  @ValidateIf(present) @IsArray() @ArrayMaxSize(MASCOT_MOODS.length) @ArrayUnique() @IsIn(MASCOT_MOODS, CODE_LIST)
  moods?: MascotMood[];

  @ApiPropertyOptional() @ValidateIf(present) @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @ValidateIf(present) @IsInt() @Min(-100000) @Max(100000) sortOrder?: number;
}

export class CreateMascotLineDto implements MascotLineInput {
  @ApiProperty({ enum: LOCALES }) @IsIn(LOCALES) locale!: MascotLocale;
  @ApiProperty({ example: 'صباح الخير يا {name}!' }) @IsString() @Length(1, 300) text!: string;
  @ApiPropertyOptional({ enum: MASCOT_MOODS, nullable: true }) @IsOptional() @IsIn(MASCOT_MOODS) mood?: MascotMood | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(-100000) @Max(100000) sortOrder?: number;
}

export class UpdateMascotLineDto implements Partial<MascotLineInput> {
  @ApiPropertyOptional({ enum: LOCALES }) @ValidateIf(present) @IsIn(LOCALES) locale?: MascotLocale;
  @ApiPropertyOptional() @ValidateIf(present) @IsString() @Length(1, 300) text?: string;
  @ApiPropertyOptional({ enum: MASCOT_MOODS, nullable: true }) @IsOptional() @IsIn(MASCOT_MOODS) mood?: MascotMood | null;
  @ApiPropertyOptional() @ValidateIf(present) @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @ValidateIf(present) @IsInt() @Min(-100000) @Max(100000) sortOrder?: number;
}

export class MascotEnabledDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
}

export class MascotLanguageDto {
  @ApiProperty({ enum: MASCOT_LANGUAGES }) @IsIn(MASCOT_LANGUAGES) language!: MascotLanguage;
}

export class MascotConfigQueryDto {
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Include inactive groups and lines (mascot.manage only)' })
  @IsOptional() @IsIn(['true', 'false'])
  all?: 'true' | 'false';
}
