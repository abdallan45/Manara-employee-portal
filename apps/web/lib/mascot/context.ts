import type { AttendanceStatusDto, MascotContext } from '@workforce/shared';

import type { MascotEvent } from './events';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Minutes after local midnight and weekday (0 = Sunday) in Asia/Amman. */
export function ammanNow(now = new Date()): { minuteOfDay: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { minuteOfDay: hour * 60 + minute, weekday: weekday === -1 ? 0 : weekday };
}

/** "HH:mm" -> minutes after midnight (for the admin "Try it" panel). */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Facts about the moment of an attendance event, for selectMascotLine. `lastBreakCode` is the break type
 * of the last status that had an open break (BREAK_END's status no longer has one).
 * Returns null for events that are not rule-driven (the admin 'say' preview).
 */
export function mascotContextFor(event: MascotEvent, lastBreakCode: string | null, now = new Date()): MascotContext | null {
  const base = ammanNow(now);
  switch (event.kind) {
    case 'say':
      return null;
    case 'poke':
      return { trigger: 'POKE', ...base };
    case 'error':
      return { trigger: 'ERROR', ...base, errorCode: event.code };
    case 'action': {
      const s: AttendanceStatusDto = event.status;
      const today = s.today;
      const workday = today.scheduled.isWorkday;
      switch (event.action) {
        case 'check-in':
          return { trigger: 'CHECK_IN', ...base, workday, isLate: today.isLate };
        case 'check-out':
          return {
            trigger: 'CHECK_OUT',
            ...base,
            workday,
            workMinusRequired: today.requiredMinutes > 0 ? today.netWorkMinutes - today.requiredMinutes : undefined,
          };
        case 'break/start':
          return { trigger: 'BREAK_START', ...base, workday, breakTypeCode: s.openBreak?.breakType.code ?? null };
        case 'break/end':
          return { trigger: 'BREAK_END', ...base, workday, breakTypeCode: lastBreakCode, breakExceeded: today.excessBreakMinutes > 0 };
      }
    }
  }
}

/** Context for the once-a-day greeting (no attendance status at that point). */
export function greetingContext(now = new Date()): MascotContext {
  return { trigger: 'GREETING', ...ammanNow(now) };
}
