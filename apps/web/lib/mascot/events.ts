import type { AttendanceStatusDto, MascotMood } from '@workforce/shared';

import type { AttendanceActionPath } from '@/lib/use-attendance-action';

/** What the mascot reacts to. Sent as a window event so any page can trigger it without prop drilling. */
export type MascotEvent =
  | { kind: 'action'; action: AttendanceActionPath; status: AttendanceStatusDto }
  | { kind: 'error'; action: AttendanceActionPath; code: string }
  | { kind: 'poke' }
  /** Admin preview: say exactly this (text as shown, recording or null = text only). Plays even when muted or switched off. */
  | { kind: 'say'; text: string; mood: MascotMood; audioUrl: string | null };

const EVENT_NAME = 'wf:mascot';

export function emitMascot(event: MascotEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MascotEvent>(EVENT_NAME, { detail: event }));
}

export function onMascot(handler: (event: MascotEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<MascotEvent>).detail);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
