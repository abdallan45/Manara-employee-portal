import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isSaturdayDate, MANAGER_STEP, MAX_APPROVAL_STEPS, normalizePortalVisibility, PortalKey, RangedSettingKey, SETTING_DEFAULTS, SETTING_RANGES, SettingDto, SettingKey,
  validatePortalVisibility,
} from '@workforce/shared';
import { IANAZone } from 'luxon';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';

const CACHE_TTL_MS = 15_000;
/** Reported as updatedAt for settings that were never changed from their default. */
const NEVER_UPDATED = new Date(0).toISOString();

type Validator = (value: unknown) => string | null;
const int = (min: number, max: number): Validator => (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? null : `must be an integer between ${min} and ${max}`;
const oneOf = (...allowed: string[]): Validator => (v) =>
  typeof v === 'string' && allowed.includes(v) ? null : `must be one of: ${allowed.join(', ')}`;
/** Integer validator from the shared SETTING_RANGES, so the web form and the API agree on the limits. */
const ranged = (key: RangedSettingKey): Validator => int(SETTING_RANGES[key].min, SETTING_RANGES[key].max);

/** Approval chain shape: 1..MAX_APPROVAL_STEPS step keys ("MANAGER" or a role key). Role existence is checked by the caller. */
const approvalSteps: Validator = (v) =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_APPROVAL_STEPS && v.every((s) => typeof s === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(s))
    ? null
    : `must be a list of 1 to ${MAX_APPROVAL_STEPS} steps ("MANAGER" or role keys)`;

const PORTAL_KEY: SettingKey = 'portal.visibility';

const VALIDATORS: Record<SettingKey, Validator> = {
  'company.name': (v) => (typeof v === 'string' && v.trim().length >= 1 && v.length <= 200 ? null : 'must be a non-empty string up to 200 characters'),
  'company.timezone': (v) => (typeof v === 'string' && IANAZone.isValidZone(v) ? null : 'must be a valid IANA time zone'),
  'attendance.locationEnforcement': oneOf('ENFORCE', 'FLAG'),
  'attendance.maxLocationAccuracyMeters': ranged('attendance.maxLocationAccuracyMeters'),
  'attendance.maxOpenSessionHours': ranged('attendance.maxOpenSessionHours'),
  'approvals.overtimeSteps': approvalSteps,
  'approvals.correctionSteps': approvalSteps,
  'auth.maxFailedLogins': ranged('auth.maxFailedLogins'),
  'auth.lockoutMinutes': ranged('auth.lockoutMinutes'),
  'auth.sessionHours': ranged('auth.sessionHours'),
  'auth.idleMinutes': ranged('auth.idleMinutes'),
  // An empty object would silently reset every toggle to visible: require at least one known key.
  'portal.visibility': (v) => validatePortalVisibility(v)
    ?? (Object.keys(v as object).length === 0 ? 'must set at least one page or section key' : null),
  'mascot.enabled': (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  'mascot.language': (v) => (v === 'auto' || v === 'ar' || v === 'en' ? null : 'must be auto, ar or en'),
  'attendance.saturdayRotaStart': (v) => (v === null || (typeof v === 'string' && isSaturdayDate(v)) ? null : 'must be null or a Saturday (YYYY-MM-DD)'),
};

export const isSettingKey = (key: string): key is SettingKey => Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key);

interface CachedRow { value: unknown; updatedAt: Date }

/** Typed access to system_settings with defaults from SETTING_DEFAULTS and a short in-process cache. */
@Injectable()
export class SettingsService {
  private cache: { rows: Map<string, CachedRow>; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async get<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
    const row = (await this.rows()).get(key);
    if (row !== undefined && VALIDATORS[key](row.value) === null) return row.value as (typeof SETTING_DEFAULTS)[K];
    return SETTING_DEFAULTS[key];
  }

  async list(): Promise<SettingDto[]> {
    const rows = await this.rows();
    const keys = Object.keys(SETTING_DEFAULTS) as SettingKey[];
    return Promise.all(keys.map(async (key) => ({
      key,
      value: key === PORTAL_KEY ? await this.portalVisibility() : await this.get(key),
      updatedAt: rows.get(key)?.updatedAt.toISOString() ?? NEVER_UPDATED,
    })));
  }

  /** Company-wide employee-portal visibility: every key present, locked pages always true. */
  async portalVisibility(): Promise<Record<PortalKey, boolean>> {
    // Lenient read: a stored value with keys from another version still keeps the known choices.
    return normalizePortalVisibility((await this.rows()).get(PORTAL_KEY)?.value);
  }

  async update(key: string, rawValue: unknown, actorUserId: string, ipAddress: string): Promise<SettingDto> {
    if (!isSettingKey(key)) throw AppError.notFound(`Unknown setting "${key}"`);
    const problem = VALIDATORS[key](rawValue);
    if (problem) throw AppError.badRequest('VALIDATION_FAILED', `${key} ${problem}`, [{ field: 'value', messages: [`${key} ${problem}`] }]);
    if (key === 'approvals.overtimeSteps' || key === 'approvals.correctionSteps') await this.assertRolesExist(key, rawValue as string[]);
    // Portal visibility is stored as a full object so the audit before/after reads as a complete picture.
    const isPortal = key === PORTAL_KEY;
    const value = isPortal ? normalizePortalVisibility(rawValue) : rawValue;
    const before = isPortal ? await this.portalVisibility() : await this.get(key);
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.systemSetting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue, updatedById: actorUserId },
        update: { value: value as Prisma.InputJsonValue, updatedById: actorUserId },
      });
      await this.audit.record(tx, {
        actorUserId, action: 'SETTING_UPDATE', entityType: 'SystemSetting', entityId: key,
        before: { value: before }, after: { value }, ipAddress,
      });
      return row;
    });
    this.invalidate();
    return { key, value: saved.value, updatedAt: saved.updatedAt.toISOString() };
  }

  /** Every step of an approval chain other than MANAGER must name an existing role. */
  private async assertRolesExist(key: string, steps: string[]): Promise<void> {
    const roleKeys = [...new Set(steps.filter((s) => s !== MANAGER_STEP))];
    const known = roleKeys.length ? await this.prisma.role.findMany({ where: { key: { in: roleKeys } }, select: { key: true } }) : [];
    const unknown = roleKeys.filter((k) => !known.some((r) => r.key === k));
    if (unknown.length) {
      const message = `${key} names unknown role(s): ${unknown.join(', ')}`;
      throw AppError.badRequest('VALIDATION_FAILED', message, [{ field: 'value', messages: [message] }]);
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  private async rows(): Promise<Map<string, CachedRow>> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.rows;
    const all = await this.prisma.systemSetting.findMany();
    const rows = new Map(all.map((r) => [r.key, { value: r.value, updatedAt: r.updatedAt }]));
    this.cache = { rows, expiresAt: Date.now() + CACHE_TTL_MS };
    return rows;
  }
}
