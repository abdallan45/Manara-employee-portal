'use client';

import { ChevronDown, ChevronUp, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mascotSpeechLocale, selectMascotLine, type MascotContext, type MascotMood } from '@workforce/shared';

import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/context';
import type { Locale } from '@/lib/i18n/dictionaries';
import { useMascotConfig } from '@/lib/mascot/config';
import { greetingContext, mascotContextFor } from '@/lib/mascot/context';
import { onMascot, type MascotEvent } from '@/lib/mascot/events';
import { playRecording, stopSpeaking } from '@/lib/mascot/speech';
import { cn } from '@/lib/utils';

import styles from './mascot.module.css';
import { NouriaSvg } from './nouria-svg';

// Mascot UI strings live here so the feature stays self-contained.
const UI: Record<Locale, { name: string; mute: string; unmute: string; minimize: string; expand: string; poke: string }> = {
  ar: { name: 'نورية', mute: 'كتم صوت نورية', unmute: 'تشغيل صوت نورية', minimize: 'تصغير نورية', expand: 'إظهار نورية', poke: 'دوس على نورية لتحكيلك' },
  en: { name: 'Nouria', mute: 'Mute Nouria', unmute: 'Unmute Nouria', minimize: 'Minimise Nouria', expand: 'Show Nouria', poke: 'Tap Nouria to chat' },
};

const PREFS_KEY = 'wf_mascot';
interface Prefs { muted: boolean; minimized: boolean; greeted: string }
const DEFAULT_PREFS: Prefs = { muted: false, minimized: false, greeted: '' };

function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return DEFAULT_PREFS; }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: preferences just don't persist */ }
}

/** What she shows and plays for one event. */
interface SpokenLine {
  text: string;
  mood: MascotMood;
  /** Her recording, or null = text only (never the device voice: it can't speak her dialect). */
  audio: string | null;
}

const BREAK_KEY = 'wf_mascot_break';
const RECENT_MAX = 6;

/** Recently spoken line ids, so she doesn't repeat herself (shared across remounts). */
const recentIds: string[] = [];

function readBreakCode(): string | null {
  try { return sessionStorage.getItem(BREAK_KEY); } catch { return null; }
}
function writeBreakCode(code: string | null) {
  try {
    if (code) sessionStorage.setItem(BREAK_KEY, code);
    else sessionStorage.removeItem(BREAK_KEY);
  } catch { /* storage unavailable: BREAK_END just won't know the break type after a reload */ }
}

/**
 * Nouria (نورية), the Manara mascot: reacts to the employee's own attendance actions with a short, spoken
 * quip. What she says comes from GET /mascot/config (managed on /admin/mascot) and is chosen with
 * selectMascotLine. Admins without an employee profile only see her while previewing a line.
 */
export function Mascot() {
  const { user } = useAuth();
  const { locale } = useI18n();
  const ui = UI[locale];
  const config = useMascotConfig(user.employee !== null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [line, setLine] = useState<SpokenLine | null>(null);
  /** The line on screen is an admin preview (shown even when she is switched off or the user has no profile). */
  const [preview, setPreview] = useState(false);
  const [mood, setMood] = useState<MascotMood>('happy');
  const [talking, setTalking] = useState(false);
  const [animation, setAnimation] = useState<'bounce' | 'party' | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const configRef = useRef(config);
  configRef.current = config;
  const lastBreakCode = useRef<string | null>(null);
  const greetChecked = useRef(false);

  const enabled = user.employee !== null && config?.enabled === true;
  /** Language of her lines: the admin's choice, or the viewer's screen language when set to auto. */
  const speechLocale = mascotSpeechLocale(config?.language ?? 'auto', locale);

  const firstName = (speechLocale === 'ar' && user.employee?.fullNameAr ? user.employee.fullNameAr : user.employee?.fullName ?? user.username).split(' ')[0] ?? '';

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => { const next = { ...p, ...patch }; savePrefs(next); return next; });
  }, []);

  const hide = useCallback(() => {
    setLine(null);
    setPreview(false);
  }, []);

  /** Picks a line for the moment, or null when no group matches (she stays quiet). */
  const pickLine = useCallback((ctx: MascotContext): SpokenLine | null => {
    const current = configRef.current;
    if (!current?.enabled) return null;
    const pick = selectMascotLine(current, ctx, mascotSpeechLocale(current.language ?? 'auto', locale), { avoid: recentIds });
    if (!pick) return null;
    recentIds.push(pick.line.id);
    if (recentIds.length > RECENT_MAX) recentIds.shift();
    return { text: pick.line.text.replaceAll('{name}', firstName), mood: pick.mood, audio: pick.line.audioUrl };
  }, [locale, firstName]);

  const say = useCallback((next: SpokenLine, opts: { voice: boolean; preview?: boolean }) => {
    window.clearTimeout(hideTimer.current);
    setLine(next);
    setPreview(opts.preview === true);
    setMood(next.mood);
    setAnimation(next.mood === 'party' ? 'party' : 'bounce');
    window.setTimeout(() => setAnimation(null), 1800);

    const voiceHooks = {
      start: () => setTalking(true),
      end: () => {
        setTalking(false);
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(hide, 2500);
      },
    };
    const silent = () => {
      // No voice: animate the mouth briefly and keep the bubble up long enough to read.
      stopSpeaking();
      setTalking(true);
      window.setTimeout(() => setTalking(false), Math.min(2400, 60 * next.text.length));
      hideTimer.current = window.setTimeout(hide, 3000 + 55 * next.text.length);
    };
    // Only her recorded voice is used. A line without a recording is text-only: the device's own voice
    // would read Arabic in formal Arabic, not her dialect. An admin preview plays even when muted.
    if (!opts.voice || (prefsRef.current.muted && !opts.preview) || !next.audio) { silent(); return; }
    void playRecording(next.audio, voiceHooks).then((ok) => { if (!ok) silent(); });
  }, [hide]);

  // Load preferences and the break type remembered for BREAK_END.
  useEffect(() => {
    setPrefs(loadPrefs());
    lastBreakCode.current = readBreakCode();
  }, []);

  // Greet once per day (text only: browsers block audio before the first tap), as soon as the content is in.
  useEffect(() => {
    if (!enabled || greetChecked.current) return undefined;
    greetChecked.current = true;
    const p = loadPrefs();
    const today = new Date().toISOString().slice(0, 10);
    if (p.greeted === today || p.minimized) return undefined;
    const t = window.setTimeout(() => {
      const greeting = pickLine(greetingContext());
      if (greeting) say(greeting, { voice: false });
      updatePrefs({ greeted: today });
    }, 1200);
    return () => window.clearTimeout(t);
  }, [enabled, pickLine, say, updatePrefs]);

  // Switched off by an admin: stop talking at once (an admin preview on screen may finish).
  useEffect(() => {
    if (enabled || preview) return;
    window.clearTimeout(hideTimer.current);
    stopSpeaking();
    setTalking(false);
    setLine(null);
  }, [enabled, preview]);

  useEffect(() => onMascot((event: MascotEvent) => {
    if (event.kind === 'action') {
      const code = event.status.openBreak?.breakType.code ?? null;
      if (code) { lastBreakCode.current = code; writeBreakCode(code); }
    }
    if (event.kind === 'say') {
      if (prefsRef.current.minimized) updatePrefs({ minimized: false });
      say({ text: event.text.replaceAll('{name}', firstName), mood: event.mood, audio: event.audioUrl }, { voice: true, preview: true });
      return;
    }
    if (!configRef.current?.enabled || user.employee === null) return;
    if (prefsRef.current.minimized && event.kind === 'poke') updatePrefs({ minimized: false });
    const ctx = mascotContextFor(event, lastBreakCode.current);
    const next = ctx ? pickLine(ctx) : null;
    if (event.kind === 'action' && event.action === 'break/end') { lastBreakCode.current = null; writeBreakCode(null); }
    if (next) say(next, { voice: true });
  }), [say, pickLine, firstName, updatePrefs, user.employee]);

  useEffect(() => () => { window.clearTimeout(hideTimer.current); stopSpeaking(); }, []);

  if (!enabled && !(preview && line)) return null;

  const poke = () => {
    if (prefs.minimized) { updatePrefs({ minimized: false }); return; }
    if (!enabled) return;
    const next = pickLine(mascotContextFor({ kind: 'poke' }, lastBreakCode.current) ?? greetingContext());
    if (next) say(next, { voice: true });
  };

  return (
    <div className={cn(styles.root, prefs.minimized && styles.minimized)}>
      {line && !prefs.minimized && (
        <div role="status" aria-live="polite" className={cn(styles.bubble, 'bg-card text-card-foreground border border-border')}>
          <p className="text-primary mb-0.5 text-xs font-semibold">{UI[speechLocale].name}</p>
          <p dir="auto">{line.text}</p>
        </div>
      )}
      <div className="flex flex-col items-center gap-1">
        {!prefs.minimized && (
          <div className={styles.controls}>
            <button
              type="button"
              onClick={() => { if (!prefs.muted) stopSpeaking(); updatePrefs({ muted: !prefs.muted }); }}
              className="bg-card text-muted-foreground hover:text-foreground border-border grid size-7 place-items-center rounded-full border"
              aria-label={prefs.muted ? ui.unmute : ui.mute}
              title={prefs.muted ? ui.unmute : ui.mute}
            >
              {prefs.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={poke}
          className={cn(styles.body, talking && styles.talking, animation === 'bounce' && styles.bounce, animation === 'party' && styles.party)}
          aria-label={prefs.minimized ? ui.expand : ui.poke}
          title={prefs.minimized ? ui.expand : ui.poke}
        >
          <NouriaSvg mood={prefs.minimized ? 'happy' : mood} talking={talking && !prefs.minimized} compact={prefs.minimized} />
        </button>
        <button
          type="button"
          onClick={() => { stopSpeaking(); hide(); updatePrefs({ minimized: !prefs.minimized }); }}
          className="bg-card text-muted-foreground hover:text-foreground border-border grid size-6 place-items-center rounded-full border"
          aria-label={prefs.minimized ? ui.expand : ui.minimize}
          title={prefs.minimized ? ui.expand : ui.minimize}
        >
          {prefs.minimized ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}
