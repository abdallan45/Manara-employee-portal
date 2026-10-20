// Nouria (the talking mascot): content managed by admins, rules evaluated on the client.
// Groups hold lines; each group has a trigger, optional conditions and a priority. When an event
// happens, the active groups for that trigger whose conditions all match are collected, the highest
// priority wins, and a random active line (in the viewer's language) from that group is spoken.

export const MASCOT_TRIGGERS = ['GREETING', 'CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END', 'ERROR', 'POKE'] as const;
export type MascotTrigger = (typeof MASCOT_TRIGGERS)[number];

export const MASCOT_MOODS = ['happy', 'party', 'wink', 'shocked', 'sleepy', 'sad'] as const;
export type MascotMood = (typeof MASCOT_MOODS)[number];

export type MascotArrival = 'EARLY' | 'ON_TIME' | 'LATE';
export type MascotLocale = 'ar' | 'en';

/** Which language Nouria speaks: `auto` follows each viewer's interface language. */
export const MASCOT_LANGUAGES = ['auto', 'ar', 'en'] as const;
export type MascotLanguage = (typeof MASCOT_LANGUAGES)[number];

/** Every field is optional; an omitted field always matches. All times are Asia/Amman local time. */
export interface MascotConditions {
  /** "HH:mm" window; when timeFrom > timeTo the window wraps past midnight. */
  timeFrom?: string;
  timeTo?: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays?: number[];
  /** true = scheduled workday, false = rest day or holiday. */
  workday?: boolean;
  /** CHECK_IN only. EARLY = checked in before `earlyBefore` (and not late). */
  arrival?: MascotArrival[];
  /** "HH:mm", default "08:00". */
  earlyBefore?: string;
  /** CHECK_OUT only: today's net work minus required minutes, inclusive bounds (e.g. min 60 = long day). */
  workVsRequired?: { min?: number; max?: number };
  /** BREAK_START / BREAK_END: break type codes (e.g. LUNCH, SHORT). */
  breakTypeCodes?: string[];
  /** BREAK_END: true = the break ran past its limit. */
  breakExceeded?: boolean;
  /** ERROR: API error codes (e.g. NETWORK_NOT_TRUSTED). */
  errorCodes?: string[];
}

export interface MascotLineDto {
  id: string;
  groupId: string;
  locale: MascotLocale;
  /** May contain {name} (employee's first name) - shown in the bubble; recordings should not say a name. */
  text: string;
  /** Overrides the group's moods for this line. */
  mood: MascotMood | null;
  /** Same-origin URL of the recording (with a version query), or null = text only. */
  audioUrl: string | null;
  audioMime: string | null;
  isActive: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface MascotGroupDto {
  id: string;
  name: string;
  description: string | null;
  trigger: MascotTrigger;
  conditions: MascotConditions;
  /** Higher wins when several groups match. */
  priority: number;
  /** Moods picked at random for lines without their own mood. Empty = happy. */
  moods: MascotMood[];
  isActive: boolean;
  sortOrder: number;
  lines: MascotLineDto[];
}

/** GET /mascot/config (any signed-in user). Inactive groups/lines are omitted for non-admins. */
export interface MascotConfigDto {
  enabled: boolean;
  /** Language of her lines and recordings for everyone; `auto` = the viewer's interface language. */
  language: MascotLanguage;
  groups: MascotGroupDto[];
  /** Changes whenever content changes; clients can cache by it. */
  version: string;
}

export interface MascotGroupInput {
  name: string;
  description?: string | null;
  trigger: MascotTrigger;
  conditions?: MascotConditions;
  priority?: number;
  moods?: MascotMood[];
  isActive?: boolean;
  sortOrder?: number;
}
export interface MascotLineInput {
  locale: MascotLocale;
  text: string;
  mood?: MascotMood | null;
  isActive?: boolean;
  sortOrder?: number;
}

/** The locale Nouria should speak in for a viewer whose interface uses `uiLocale`. */
export const mascotSpeechLocale = (language: MascotLanguage, uiLocale: MascotLocale): MascotLocale =>
  language === 'auto' ? uiLocale : language;

/** Facts about the moment an event happened, built by the client from AttendanceStatusDto. */
export interface MascotContext {
  trigger: MascotTrigger;
  /** Minutes after local midnight (Asia/Amman). */
  minuteOfDay: number;
  /** 0 = Sunday … 6 = Saturday (Asia/Amman). */
  weekday: number;
  workday?: boolean;
  isLate?: boolean;
  workMinusRequired?: number;
  breakTypeCode?: string | null;
  breakExceeded?: boolean;
  errorCode?: string | null;
}

const toMinutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** Validates "HH:mm" (00:00–23:59). */
export const isMascotTime = (hhmm: string): boolean => {
  const v = toMinutes(hhmm);
  return Number.isFinite(v) && v >= 0 && v < 1440 && Number(hhmm.split(':')[1]) < 60;
};

function inTimeWindow(minute: number, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const a = from ? toMinutes(from) : 0;
  const b = to ? toMinutes(to) : 1440;
  return a <= b ? minute >= a && minute < b : minute >= a || minute < b;
}

/** Arrival classification used by the `arrival` condition. */
export function mascotArrival(ctx: MascotContext, earlyBefore = '08:00'): MascotArrival {
  if (ctx.isLate) return 'LATE';
  return ctx.minuteOfDay < toMinutes(earlyBefore) ? 'EARLY' : 'ON_TIME';
}

/** True when every condition the group sets is satisfied by the context. */
export function mascotConditionsMatch(c: MascotConditions, ctx: MascotContext): boolean {
  if (!inTimeWindow(ctx.minuteOfDay, c.timeFrom, c.timeTo)) return false;
  if (c.weekdays?.length && !c.weekdays.includes(ctx.weekday)) return false;
  if (c.workday !== undefined && ctx.workday !== undefined && c.workday !== ctx.workday) return false;
  if (c.workday !== undefined && ctx.workday === undefined) return false;
  if (c.arrival?.length && !c.arrival.includes(mascotArrival(ctx, c.earlyBefore))) return false;
  if (c.workVsRequired) {
    const v = ctx.workMinusRequired;
    if (v === undefined) return false;
    if (c.workVsRequired.min !== undefined && v < c.workVsRequired.min) return false;
    if (c.workVsRequired.max !== undefined && v > c.workVsRequired.max) return false;
  }
  if (c.breakTypeCodes?.length && !(ctx.breakTypeCode && c.breakTypeCodes.includes(ctx.breakTypeCode))) return false;
  if (c.breakExceeded !== undefined && Boolean(ctx.breakExceeded) !== c.breakExceeded) return false;
  if (c.errorCodes?.length && !(ctx.errorCode && c.errorCodes.includes(ctx.errorCode))) return false;
  return true;
}

export interface MascotPick { group: MascotGroupDto; line: MascotLineDto; mood: MascotMood }

/**
 * Picks the line to say. Active groups for the trigger whose conditions match -> highest priority
 * (ties: lower sortOrder) -> random active line in `locale` (falls back to the other language when the
 * group has none). `avoid` holds recently used line ids to reduce repeats. Returns null when nothing matches.
 */
export function selectMascotLine(
  config: Pick<MascotConfigDto, 'groups'>,
  ctx: MascotContext,
  locale: MascotLocale,
  opts: { avoid?: string[]; random?: () => number } = {},
): MascotPick | null {
  const random = opts.random ?? Math.random;
  const candidates = config.groups
    .filter((g) => g.isActive && g.trigger === ctx.trigger && mascotConditionsMatch(g.conditions ?? {}, ctx))
    .filter((g) => g.lines.some((l) => l.isActive))
    .sort((a, b) => b.priority - a.priority || a.sortOrder - b.sortOrder);
  for (const group of candidates) {
    const active = group.lines.filter((l) => l.isActive);
    const own = active.filter((l) => l.locale === locale);
    const pool = own.length ? own : active;
    const fresh = pool.filter((l) => !opts.avoid?.includes(l.id));
    const choice = (fresh.length ? fresh : pool)[Math.floor(random() * (fresh.length || pool.length))];
    if (!choice) continue;
    const moods = group.moods.length ? group.moods : (['happy'] as MascotMood[]);
    const mood = choice.mood ?? moods[Math.floor(random() * moods.length)] ?? 'happy';
    return { group, line: choice, mood };
  }
  return null;
}

/** Accepted upload types for recordings and the size limit (bytes). */
export const MASCOT_AUDIO_MIME = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac'] as const;
export const MASCOT_AUDIO_MAX_BYTES = 3 * 1024 * 1024;
