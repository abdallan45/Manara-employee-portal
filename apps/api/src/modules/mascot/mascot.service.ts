import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  MASCOT_AUDIO_MAX_BYTES, PERMISSIONS, type MascotConditions, type MascotConfigDto, type MascotGroupDto,
  type MascotLanguage, type MascotLineDto, type MascotLocale, type MascotMood,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import type { Db } from '../../common/prisma.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { checkAudio } from './mascot-audio';
import type {
  CreateMascotGroupDto, CreateMascotLineDto, MascotConditionsDto, UpdateMascotGroupDto, UpdateMascotLineDto,
} from './mascot.dto';

/** The parts of a multer file we use (memory storage). */
export interface UploadedAudio {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Every line column except the recording itself. */
const LINE_SELECT = {
  id: true, groupId: true, locale: true, text: true, mood: true, isActive: true, sortOrder: true,
  audioMime: true, audioSha256: true, audioSize: true, createdAt: true, updatedAt: true,
} satisfies Prisma.MascotLineSelect;
type LineRow = Prisma.MascotLineGetPayload<{ select: typeof LINE_SELECT }>;

const GROUP_SELECT = {
  id: true, name: true, description: true, trigger: true, conditions: true, priority: true, moods: true,
  isActive: true, sortOrder: true, createdAt: true, updatedAt: true,
} satisfies Prisma.MascotGroupSelect;
type GroupRow = Prisma.MascotGroupGetPayload<{ select: typeof GROUP_SELECT }>;

const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] as const;

export const audioUrl = (line: Pick<LineRow, 'id' | 'audioSha256'>): string | null =>
  line.audioSha256 ? `/api/v1/mascot/lines/${line.id}/audio?v=${line.audioSha256.slice(0, 12)}` : null;

export const lineToDto = (l: LineRow): MascotLineDto => ({
  id: l.id,
  groupId: l.groupId,
  locale: l.locale as MascotLocale,
  text: l.text,
  mood: (l.mood as MascotMood | null) ?? null,
  audioUrl: audioUrl(l),
  audioMime: l.audioSha256 ? l.audioMime : null,
  isActive: l.isActive,
  sortOrder: l.sortOrder,
  updatedAt: l.updatedAt.toISOString(),
});

export const groupToDto = (g: GroupRow, lines: LineRow[]): MascotGroupDto => ({
  id: g.id,
  name: g.name,
  description: g.description,
  trigger: g.trigger,
  conditions: (g.conditions ?? {}) as MascotConditions,
  priority: g.priority,
  moods: g.moods as MascotMood[],
  isActive: g.isActive,
  sortOrder: g.sortOrder,
  lines: lines.map(lineToDto),
});

/** Audit snapshot of a line: the recording is described by type, size and hash, never included. */
const lineAudit = (l: LineRow) => ({
  id: l.id, groupId: l.groupId, locale: l.locale, text: l.text, mood: l.mood, isActive: l.isActive, sortOrder: l.sortOrder,
  audio: l.audioSha256 ? { mime: l.audioMime, size: l.audioSize, sha256: l.audioSha256 } : null,
});
const groupAudit = (g: GroupRow) => ({
  id: g.id, name: g.name, description: g.description, trigger: g.trigger, conditions: g.conditions,
  priority: g.priority, moods: g.moods, isActive: g.isActive, sortOrder: g.sortOrder,
});

/** Plain JSON conditions without empty lists or empty bounds (they would match everything anyway). */
export function normaliseConditions(c: MascotConditionsDto | MascotConditions | undefined): MascotConditions {
  const out: MascotConditions = {};
  if (!c) return out;
  if (c.timeFrom !== undefined) out.timeFrom = c.timeFrom;
  if (c.timeTo !== undefined) out.timeTo = c.timeTo;
  if (c.weekdays?.length) out.weekdays = [...c.weekdays].sort((a, b) => a - b);
  if (c.workday !== undefined) out.workday = c.workday;
  if (c.arrival?.length) out.arrival = [...c.arrival];
  if (c.earlyBefore !== undefined) out.earlyBefore = c.earlyBefore;
  if (c.workVsRequired && (c.workVsRequired.min !== undefined || c.workVsRequired.max !== undefined)) {
    out.workVsRequired = {};
    if (c.workVsRequired.min !== undefined) out.workVsRequired.min = c.workVsRequired.min;
    if (c.workVsRequired.max !== undefined) out.workVsRequired.max = c.workVsRequired.max;
  }
  if (c.breakTypeCodes?.length) out.breakTypeCodes = c.breakTypeCodes.map((s) => s.trim());
  if (c.breakExceeded !== undefined) out.breakExceeded = c.breakExceeded;
  if (c.errorCodes?.length) out.errorCodes = c.errorCodes.map((s) => s.trim());
  return out;
}

function requiredText(value: string, field: string, max: number): string {
  const v = value.trim();
  if (!v || v.length > max) {
    throw AppError.badRequest('VALIDATION_FAILED', `${field} must be 1–${max} characters`, [{ field, messages: [`${field} must not be blank`] }]);
  }
  return v;
}

const canManage = (user: AuthUser) => user.permissions.has(PERMISSIONS.MASCOT_MANAGE);

/** Nouria's content: groups of lines with recordings, plus the company-wide on/off switch. */
@Injectable()
export class MascotService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  async config(user: AuthUser, all: boolean): Promise<MascotConfigDto> {
    if (all && !canManage(user)) throw AppError.forbidden();
    const activeOnly = !all;
    const groups = await this.prisma.mascotGroup.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: [...ORDER],
      select: { ...GROUP_SELECT, lines: { where: activeOnly ? { isActive: true } : undefined, orderBy: [...ORDER], select: LINE_SELECT } },
    });
    const enabled = await this.settings.get('mascot.enabled');
    const language = await this.settings.get('mascot.language');
    const dtos = groups.map(({ lines, ...g }) => groupToDto(g, lines));
    // Content hash plus group timestamps: any edit, recording change, on/off or language change yields a new version.
    const stamps = groups.map((g) => g.updatedAt.toISOString());
    const version = createHash('sha256').update(JSON.stringify({ enabled, language, dtos, stamps })).digest('hex').slice(0, 16);
    return { enabled, language, groups: dtos, version };
  }

  /** The recording of a line; inactive lines (or lines of inactive groups) only for managers. */
  async audio(user: AuthUser, lineId: string): Promise<{ data: Buffer; mime: string; sha256: string }> {
    const line = await this.prisma.mascotLine.findUnique({
      where: { id: lineId },
      select: { audio: true, audioMime: true, audioSha256: true, isActive: true, group: { select: { isActive: true } } },
    });
    const visible = line && (canManage(user) || (line.isActive && line.group.isActive));
    if (!line || !visible || !line.audio || !line.audioSha256) throw AppError.notFound('Recording not found');
    return { data: Buffer.from(line.audio), mime: line.audioMime ?? 'application/octet-stream', sha256: line.audioSha256 };
  }

  async createGroup(user: AuthUser, body: CreateMascotGroupDto): Promise<MascotGroupDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.mascotGroup.create({
        data: {
          name: requiredText(body.name, 'name', 120),
          description: body.description?.trim() || null,
          trigger: body.trigger,
          conditions: normaliseConditions(body.conditions) as Prisma.InputJsonObject,
          priority: body.priority ?? 0,
          moods: body.moods ?? [],
          isActive: body.isActive ?? true,
          sortOrder: body.sortOrder ?? (await this.nextGroupSort(tx)),
        },
        select: GROUP_SELECT,
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_GROUP_CREATE', entityType: 'MascotGroup', entityId: row.id, after: groupAudit(row), ipAddress: user.ip });
      return groupToDto(row, []);
    });
  }

  async updateGroup(user: AuthUser, id: string, body: UpdateMascotGroupDto): Promise<MascotGroupDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.mascotGroup.findUnique({ where: { id }, select: GROUP_SELECT });
      if (!before) throw AppError.notFound('Mascot group not found');
      const row = await tx.mascotGroup.update({
        where: { id },
        data: {
          name: body.name === undefined ? undefined : requiredText(body.name, 'name', 120),
          description: body.description === undefined ? undefined : body.description?.trim() || null,
          trigger: body.trigger,
          conditions: body.conditions === undefined ? undefined : (normaliseConditions(body.conditions) as Prisma.InputJsonObject),
          priority: body.priority,
          moods: body.moods,
          isActive: body.isActive,
          sortOrder: body.sortOrder,
        },
        select: GROUP_SELECT,
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_GROUP_UPDATE', entityType: 'MascotGroup', entityId: id, before: groupAudit(before), after: groupAudit(row), ipAddress: user.ip });
      const lines = await tx.mascotLine.findMany({ where: { groupId: id }, orderBy: [...ORDER], select: LINE_SELECT });
      return groupToDto(row, lines);
    });
  }

  /** Deletes the group; its lines (and recordings) go with it. */
  async deleteGroup(user: AuthUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.mascotGroup.findUnique({ where: { id }, select: GROUP_SELECT });
      if (!before) throw AppError.notFound('Mascot group not found');
      const lines = await tx.mascotLine.findMany({ where: { groupId: id }, orderBy: [...ORDER], select: LINE_SELECT });
      await tx.mascotGroup.delete({ where: { id } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'MASCOT_GROUP_DELETE', entityType: 'MascotGroup', entityId: id,
        before: { ...groupAudit(before), lines: lines.map(lineAudit) }, ipAddress: user.ip,
      });
    });
  }

  async createLine(user: AuthUser, groupId: string, body: CreateMascotLineDto): Promise<MascotLineDto> {
    return this.prisma.$transaction(async (tx) => {
      const group = await tx.mascotGroup.findUnique({ where: { id: groupId }, select: { id: true } });
      if (!group) throw AppError.notFound('Mascot group not found');
      const last = await tx.mascotLine.aggregate({ where: { groupId }, _max: { sortOrder: true } });
      const row = await tx.mascotLine.create({
        data: {
          groupId,
          locale: body.locale,
          text: requiredText(body.text, 'text', 300),
          mood: body.mood ?? null,
          isActive: body.isActive ?? true,
          sortOrder: body.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
        },
        select: LINE_SELECT,
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_LINE_CREATE', entityType: 'MascotLine', entityId: row.id, after: lineAudit(row), ipAddress: user.ip });
      return lineToDto(row);
    });
  }

  async updateLine(user: AuthUser, id: string, body: UpdateMascotLineDto): Promise<MascotLineDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.mascotLine.findUnique({ where: { id }, select: LINE_SELECT });
      if (!before) throw AppError.notFound('Mascot line not found');
      const row = await tx.mascotLine.update({
        where: { id },
        data: {
          locale: body.locale,
          text: body.text === undefined ? undefined : requiredText(body.text, 'text', 300),
          mood: body.mood,
          isActive: body.isActive,
          sortOrder: body.sortOrder,
        },
        select: LINE_SELECT,
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_LINE_UPDATE', entityType: 'MascotLine', entityId: id, before: lineAudit(before), after: lineAudit(row), ipAddress: user.ip });
      return lineToDto(row);
    });
  }

  async deleteLine(user: AuthUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.mascotLine.findUnique({ where: { id }, select: LINE_SELECT });
      if (!before) throw AppError.notFound('Mascot line not found');
      await tx.mascotLine.delete({ where: { id } });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_LINE_DELETE', entityType: 'MascotLine', entityId: id, before: lineAudit(before), ipAddress: user.ip });
    });
  }

  async setAudio(user: AuthUser, id: string, file: UploadedAudio | undefined): Promise<MascotLineDto> {
    if (!file || !file.buffer?.length) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Attach a recording in the "file" field', [{ field: 'file', messages: ['file is required'] }]);
    }
    if (file.size > MASCOT_AUDIO_MAX_BYTES) {
      throw new AppError('VALIDATION_FAILED', `A recording may be at most ${MASCOT_AUDIO_MAX_BYTES / 1024 / 1024} MB`, HttpStatus.PAYLOAD_TOO_LARGE, { maxBytes: MASCOT_AUDIO_MAX_BYTES });
    }
    const checked = checkAudio(file.mimetype, file.buffer);
    if ('problem' in checked) throw AppError.badRequest('VALIDATION_FAILED', checked.problem, [{ field: 'file', messages: [checked.problem] }]);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.mascotLine.findUnique({ where: { id }, select: LINE_SELECT });
      if (!before) throw AppError.notFound('Mascot line not found');
      const row = await tx.mascotLine.update({
        where: { id },
        data: { audio: file.buffer, audioMime: checked.mime, audioSha256: sha256, audioSize: file.buffer.length },
        select: LINE_SELECT,
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_AUDIO_SET', entityType: 'MascotLine', entityId: id, before: lineAudit(before).audio, after: lineAudit(row).audio, ipAddress: user.ip });
      return lineToDto(row);
    });
  }

  async deleteAudio(user: AuthUser, id: string): Promise<MascotLineDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.mascotLine.findUnique({ where: { id }, select: LINE_SELECT });
      if (!before) throw AppError.notFound('Mascot line not found');
      if (!before.audioSha256) return lineToDto(before);
      const row = await tx.mascotLine.update({
        where: { id },
        data: { audio: null, audioMime: null, audioSha256: null, audioSize: null },
        select: LINE_SELECT,
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'MASCOT_AUDIO_DELETE', entityType: 'MascotLine', entityId: id, before: lineAudit(before).audio, ipAddress: user.ip });
      return lineToDto(row);
    });
  }

  /** Goes through SettingsService so its cache is invalidated and the change is audited as SETTING_UPDATE. */
  async setLanguage(user: AuthUser, language: MascotLanguage): Promise<{ language: MascotLanguage }> {
    await this.settings.update('mascot.language', language, user.userId, user.ip);
    return { language: await this.settings.get('mascot.language') };
  }

  async setEnabled(user: AuthUser, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.settings.update('mascot.enabled', enabled, user.userId, user.ip);
    return { enabled: await this.settings.get('mascot.enabled') };
  }

  private async nextGroupSort(db: Db): Promise<number> {
    const last = await db.mascotGroup.aggregate({ _max: { sortOrder: true } });
    return (last._max.sortOrder ?? -1) + 1;
  }
}
