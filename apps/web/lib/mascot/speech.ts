import type { Locale } from '@/lib/i18n/dictionaries';

/**
 * Text-to-speech through the browser's built-in Web Speech API: no network or external service,
 * so it works on the office LAN. Which voices exist depends on the device (Windows needs the
 * Arabic speech pack for Arabic; Android and iOS usually have one).
 */
export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

let cachedVoices: SpeechSynthesisVoice[] = [];
function voices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  const list = window.speechSynthesis.getVoices();
  if (list.length) cachedVoices = list;
  return cachedVoices;
}
if (speechSupported()) {
  // Chrome loads voices asynchronously.
  window.speechSynthesis.addEventListener?.('voiceschanged', () => voices());
}

/** Best local voice for the language, preferring Levantine/Gulf Arabic and on-device voices. */
export function voiceFor(locale: Locale): SpeechSynthesisVoice | null {
  const all = voices().filter((v) => v.lang.toLowerCase().startsWith(locale));
  if (!all.length) return null;
  const preferred = locale === 'ar' ? ['ar-jo', 'ar-sa', 'ar-ae', 'ar-eg'] : ['en-gb', 'en-us'];
  const score = (v: SpeechSynthesisVoice) => {
    const i = preferred.indexOf(v.lang.toLowerCase());
    return (v.localService ? 0 : 10) + (i === -1 ? 5 : i);
  };
  return [...all].sort((a, b) => score(a) - score(b))[0] ?? null;
}

/**
 * Speaks the text. Returns false when no voice for the language exists (we never read Arabic
 * with an English voice). Callbacks drive the mascot's talking animation.
 */
export function speak(text: string, locale: Locale, on: { start?: () => void; end?: () => void } = {}): boolean {
  if (!speechSupported()) return false;
  const voice = voiceFor(locale);
  if (!voice) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  // Emoji are read aloud literally by some engines; strip them from the spoken text.
  const spoken = text.replace(/\p{Extended_Pictographic}/gu, '').trim();
  const u = new SpeechSynthesisUtterance(spoken);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = locale === 'ar' ? 1 : 1.05;
  u.pitch = 1.35; // a little higher: friendly cartoon voice
  u.onstart = () => on.start?.();
  u.onend = () => on.end?.();
  u.onerror = () => on.end?.();
  synth.speak(u);
  return true;
}

let current: HTMLAudioElement | null = null;

/*
 * Lip sync: recordings are routed through one shared Web Audio AnalyserNode so the mascot can open
 * her mouth with the loudness of the voice. The AudioContext is created lazily on the first play
 * (inside the tap that triggered it). The element is only rerouted once the context is actually
 * running, so a context the browser keeps suspended can never silence the recording; in that case
 * getVoiceLevel() returns null and the mascot falls back to a timed mouth loop.
 */
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let samples: Float32Array<ArrayBuffer> | null = null;
let analysed: { audio: HTMLAudioElement; source: MediaElementAudioSourceNode } | null = null;

function ensureAnalyser(): boolean {
  if (analyser) return true;
  if (typeof window === 'undefined') return false;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return false;
  try {
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.3;
    analyser.connect(audioCtx.destination);
    samples = new Float32Array(analyser.fftSize);
    return true;
  } catch {
    audioCtx = null; analyser = null;
    return false;
  }
}

function detachAnalysed(): void {
  if (!analysed) return;
  try { analysed.source.disconnect(); } catch { /* already disconnected */ }
  analysed = null;
}

function attachAnalyser(audio: HTMLAudioElement): void {
  if (!ensureAnalyser() || !audioCtx || !analyser) return;
  const ctx = audioCtx;
  const connect = () => {
    if (current !== audio || ctx.state !== 'running' || !analyser) return;
    try {
      detachAnalysed();
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analysed = { audio, source };
    } catch { /* element already wired or blocked: no live level, the timed loop takes over */ }
  };
  if (ctx.state === 'running') connect();
  else void ctx.resume().then(connect, () => undefined);
}

/**
 * Loudness of the recording that is playing right now, 0..1 - or null when nothing analysable is
 * playing (device voice, muted, or Web Audio unavailable), so the caller can animate on its own.
 */
export function getVoiceLevel(): number | null {
  if (!analyser || !samples || !analysed || !current || analysed.audio !== current || current.paused || current.ended) return null;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, Math.max(0, (rms - 0.012) * 4.5));
}

/**
 * Plays a pre-recorded line (Jordanian voice). Resolves false when it can't play - missing file,
 * or the browser refusing autoplay before the first tap - so the caller can fall back.
 */
export function playRecording(url: string, on: { start?: () => void; end?: () => void } = {}): Promise<boolean> {
  if (typeof Audio === 'undefined') return Promise.resolve(false);
  stopSpeaking();
  const audio = new Audio(url);
  current = audio;
  const finish = () => { if (analysed?.audio === audio) detachAnalysed(); on.end?.(); };
  audio.addEventListener('playing', () => on.start?.(), { once: true });
  audio.addEventListener('ended', finish, { once: true });
  audio.addEventListener('error', finish, { once: true });
  attachAnalyser(audio);
  return audio.play().then(() => true, () => { finish(); return false; });
}

export function stopSpeaking(): void {
  if (current) { current.pause(); current = null; }
  detachAnalysed();
  if (speechSupported()) window.speechSynthesis.cancel();
}
