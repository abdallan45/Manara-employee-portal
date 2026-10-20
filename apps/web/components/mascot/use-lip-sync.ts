'use client';

import { useEffect, useState, type RefObject } from 'react';

import { getVoiceLevel } from '@/lib/mascot/speech';

export type TalkShape = 'closed' | 'small' | 'open' | 'wide';

function shapeFor(level: number): TalkShape {
  if (level < 0.08) return 'closed';
  if (level < 0.3) return 'small';
  if (level < 0.58) return 'open';
  return 'wide';
}

/**
 * Drives the mouth while the mascot talks. Each animation frame it reads the live loudness of the
 * playing recording (Web Audio analyser in lib/mascot/speech.ts); when there is none - device
 * voice, muted "silent" talking, or no Web Audio - it runs a syllable-like timed loop instead.
 * Returns null when not talking (the face then shows its mood's resting mouth).
 * The current level is mirrored to `data-level` on `levelEl` for debugging/verification.
 */
export function useLipSync(talking: boolean, levelEl?: RefObject<SVGSVGElement | null>): TalkShape | null {
  const [shape, setShape] = useState<TalkShape>('closed');

  useEffect(() => {
    if (!talking) return undefined;
    const el = levelEl?.current ?? null;
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const minGap = reduced ? 280 : 70; // ms between mouth changes
    const t0 = performance.now();
    let raf = 0;
    let smooth = 0;
    let last: TalkShape | null = null; // forces a state update on the first frame
    let lastChange = 0;

    const tick = (now: number) => {
      const live = getVoiceLevel();
      let level: number;
      if (live === null) {
        const t = (now - t0) / 1000;
        level = Math.max(0, 0.22 + 0.5 * Math.sin(t * 12.5) + 0.3 * Math.sin(t * 4.1 + 1.3));
      } else {
        level = live;
      }
      // Fast attack, slower release, so syllables read clearly.
      smooth = level > smooth ? level : smooth * 0.8 + level * 0.2;
      if (el) {
        el.dataset.level = smooth.toFixed(3);
        el.dataset.levelSource = live === null ? 'timed' : 'analyser';
      }
      const next = shapeFor(smooth);
      if (next !== last && now - lastChange >= minGap) {
        last = next;
        lastChange = now;
        setShape(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (el) el.dataset.level = '0';
    };
  }, [talking, levelEl]);

  return talking ? shape : null;
}
