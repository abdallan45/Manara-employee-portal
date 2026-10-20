import {
  MASCOT_AUDIO_MAX_BYTES,
  MASCOT_AUDIO_MIME,
  MASCOT_TRIGGERS,
  mascotArrival,
  mascotConditionsMatch,
  type BreakTypeDto,
  type MascotConditions,
  type MascotConfigDto,
  type MascotContext,
  type MascotGroupDto,
  type MascotLineDto,
  type MascotTrigger,
} from '@workforce/shared';

import { fmt, type Dictionary, type Locale } from '@/lib/i18n/dictionaries';
import { minutesOf } from '@/lib/mascot/context';

export type ConditionKey = keyof MascotConditions;

/** Condition fields that mean something for each trigger (the editor shows only these and drops the rest on save). */
export const RELEVANT: Record<MascotTrigger, readonly ConditionKey[]> = {
  GREETING: ['timeFrom', 'timeTo', 'weekdays'],
  POKE: ['timeFrom', 'timeTo', 'weekdays'],
  ERROR: ['timeFrom', 'timeTo', 'weekdays', 'errorCodes'],
  CHECK_IN: ['timeFrom', 'timeTo', 'weekdays', 'workday', 'arrival', 'earlyBefore'],
  CHECK_OUT: ['timeFrom', 'timeTo', 'weekdays', 'workday', 'workVsRequired'],
  BREAK_START: ['timeFrom', 'timeTo', 'weekdays', 'workday', 'breakTypeCodes'],
  BREAK_END: ['timeFrom', 'timeTo', 'weekdays', 'workday', 'breakTypeCodes', 'breakExceeded'],
};

export const COMMON_ERROR_CODES = ['LOCATION_OUTSIDE_OFFICE', 'LOCATION_REQUIRED', 'ATTENDANCE_INVALID_TRANSITION', 'RATE_LIMITED'] as const;

/** Removes empty values and fields that don't apply to the trigger. */
export function cleanConditions(c: MascotConditions, trigger: MascotTrigger): MascotConditions {
  const keep = new Set<ConditionKey>(RELEVANT[trigger]);
  const out: MascotConditions = {};
  if (keep.has('timeFrom') && c.timeFrom) out.timeFrom = c.timeFrom;
  if (keep.has('timeTo') && c.timeTo) out.timeTo = c.timeTo;
  if (keep.has('weekdays') && c.weekdays?.length) out.weekdays = [...c.weekdays].sort((a, b) => a - b);
  if (keep.has('workday') && c.workday !== undefined) out.workday = c.workday;
  if (keep.has('arrival') && c.arrival?.length) out.arrival = c.arrival;
  if (keep.has('earlyBefore') && c.earlyBefore) out.earlyBefore = c.earlyBefore;
  if (keep.has('workVsRequired') && c.workVsRequired && (c.workVsRequired.min !== undefined || c.workVsRequired.max !== undefined)) {
    out.workVsRequired = {};
    if (c.workVsRequired.min !== undefined) out.workVsRequired.min = c.workVsRequired.min;
    if (c.workVsRequired.max !== undefined) out.workVsRequired.max = c.workVsRequired.max;
  }
  if (keep.has('breakTypeCodes') && c.breakTypeCodes?.length) out.breakTypeCodes = c.breakTypeCodes;
  if (keep.has('breakExceeded') && c.breakExceeded !== undefined) out.breakExceeded = c.breakExceeded;
  if (keep.has('errorCodes') && c.errorCodes?.length) out.errorCodes = c.errorCodes;
  return out;
}

export const breakTypeName = (code: string, breakTypes: BreakTypeDto[] | undefined, locale: Locale): string => {
  const bt = breakTypes?.find((b) => b.code === code);
  return bt ? (locale === 'ar' && bt.nameAr) || bt.name : code;
};

/** Human-readable conditions, e.g. «قبل 12:00 · أيام الدوام · متأخر». */
export function conditionSummary(c: MascotConditions, t: Dictionary, locale: Locale, breakTypes?: BreakTypeDto[]): string {
  const m = t.mascotAdmin;
  const s = m.summary;
  const parts: string[] = [];
  if (c.timeFrom && c.timeTo) {
    parts.push(fmt(minutesOf(c.timeFrom) > minutesOf(c.timeTo) ? s.overnight : s.between, { from: c.timeFrom, to: c.timeTo }));
  } else if (c.timeTo) parts.push(fmt(s.before, { time: c.timeTo }));
  else if (c.timeFrom) parts.push(fmt(s.after, { time: c.timeFrom }));
  if (c.weekdays?.length) parts.push([...c.weekdays].sort((a, b) => a - b).map((d) => m.weekdaysShort[d] ?? String(d)).join(locale === 'ar' ? '، ' : ', '));
  if (c.workday !== undefined) parts.push(c.workday ? s.workday : s.restDay);
  if (c.arrival?.length) {
    const arrival = c.arrival.map((a) => m.arrival[a]).join(s.or);
    parts.push(c.arrival.includes('EARLY') && c.earlyBefore ? `${arrival} (${fmt(s.earlyBefore, { time: c.earlyBefore })})` : arrival);
  }
  const w = c.workVsRequired;
  if (w && (w.min !== undefined || w.max !== undefined)) {
    if (w.min !== undefined && w.max !== undefined) parts.push(fmt(s.workBetween, { min: w.min, max: w.max }));
    else if (w.min !== undefined) parts.push(fmt(s.workMin, { min: w.min }));
    else parts.push(fmt(s.workMax, { max: w.max ?? 0 }));
  }
  if (c.breakTypeCodes?.length) parts.push(c.breakTypeCodes.map((code) => breakTypeName(code, breakTypes, locale)).join(s.or));
  if (c.breakExceeded !== undefined) parts.push(c.breakExceeded ? s.breakOver : s.breakOnTime);
  if (c.errorCodes?.length) parts.push(c.errorCodes.join(s.or));
  return parts.length ? parts.join(' · ') : s.always;
}

/** Groups by trigger (contract order), then priority (high first), then sortOrder. */
export function sortGroups(groups: MascotGroupDto[]): MascotGroupDto[] {
  const order = (tr: MascotTrigger) => MASCOT_TRIGGERS.indexOf(tr);
  return [...groups].sort((a, b) => order(a.trigger) - order(b.trigger) || b.priority - a.priority || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Why a group would not be used in this context (empty = it matches). Each condition is tested on its own with mascotConditionsMatch. */
export function mismatchReasons(g: MascotGroupDto, ctx: MascotContext, t: Dictionary): string[] {
  const r = t.mascotAdmin.tryIt;
  const c = g.conditions ?? {};
  const out: string[] = [];
  if (!g.isActive) out.push(r.reasonInactive);
  if (!g.lines.some((l) => l.isActive)) out.push(r.reasonNoLines);
  const test = (part: MascotConditions) => mascotConditionsMatch(part, ctx);
  if ((c.timeFrom || c.timeTo) && !test({ timeFrom: c.timeFrom, timeTo: c.timeTo })) out.push(r.reasonTime);
  if (c.weekdays?.length && !test({ weekdays: c.weekdays })) out.push(r.reasonWeekdays);
  if (c.workday !== undefined && !test({ workday: c.workday })) out.push(r.reasonWorkday);
  if (c.arrival?.length && !test({ arrival: c.arrival, earlyBefore: c.earlyBefore })) {
    out.push(fmt(r.reasonArrival, { arrival: t.mascotAdmin.arrival[mascotArrival(ctx, c.earlyBefore)] }));
  }
  if (c.workVsRequired && !test({ workVsRequired: c.workVsRequired })) out.push(r.reasonWork);
  if (c.breakTypeCodes?.length && !test({ breakTypeCodes: c.breakTypeCodes })) out.push(r.reasonBreakTypes);
  if (c.breakExceeded !== undefined && !test({ breakExceeded: c.breakExceeded })) out.push(r.reasonBreakExceeded);
  if (c.errorCodes?.length && !test({ errorCodes: c.errorCodes })) out.push(r.reasonErrorCodes);
  return out;
}

// ───────── Local copy of the config after a mutation ─────────

export function withGroup(cfg: MascotConfigDto, group: MascotGroupDto): MascotConfigDto {
  const existing = cfg.groups.find((g) => g.id === group.id);
  // A group PATCH may answer without lines; keep the ones on screen then.
  const merged = { ...group, lines: Array.isArray(group.lines) ? group.lines : existing?.lines ?? [] };
  return { ...cfg, groups: existing ? cfg.groups.map((g) => (g.id === group.id ? merged : g)) : [...cfg.groups, merged] };
}

export const patchGroup = (cfg: MascotConfigDto, id: string, patch: Partial<MascotGroupDto>): MascotConfigDto => ({
  ...cfg,
  groups: cfg.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
});

export const patchLine = (cfg: MascotConfigDto, id: string, patch: Partial<MascotLineDto>): MascotConfigDto => ({
  ...cfg,
  groups: cfg.groups.map((g) => (g.lines.some((l) => l.id === id) ? { ...g, lines: g.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : g)),
});

export const withoutGroup = (cfg: MascotConfigDto, id: string): MascotConfigDto => ({ ...cfg, groups: cfg.groups.filter((g) => g.id !== id) });

export function withLine(cfg: MascotConfigDto, line: MascotLineDto): MascotConfigDto {
  return {
    ...cfg,
    groups: cfg.groups.map((g) => {
      if (g.id !== line.groupId) return g;
      const has = g.lines.some((l) => l.id === line.id);
      return { ...g, lines: has ? g.lines.map((l) => (l.id === line.id ? line : l)) : [...g.lines, line] };
    }),
  };
}

export const withoutLine = (cfg: MascotConfigDto, id: string): MascotConfigDto => ({
  ...cfg,
  groups: cfg.groups.map((g) => (g.lines.some((l) => l.id === id) ? { ...g, lines: g.lines.filter((l) => l.id !== id) } : g)),
});

// ───────── Recordings ─────────

export const AUDIO_ACCEPT = [...MASCOT_AUDIO_MIME, '.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac'].join(',');
const EXT_MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac' };

/** null = OK, else the reason ('size' | 'type'). Browsers sometimes leave File.type empty; the extension decides then. */
export function audioFileProblem(file: File): 'size' | 'type' | null {
  if (file.size > MASCOT_AUDIO_MAX_BYTES) return 'size';
  const base = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base) return (MASCOT_AUDIO_MIME as readonly string[]).includes(base) ? null : 'type';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ext in EXT_MIME ? null : 'type';
}

export const maxAudioMb = (): string => String(Math.round((MASCOT_AUDIO_MAX_BYTES / (1024 * 1024)) * 10) / 10);
