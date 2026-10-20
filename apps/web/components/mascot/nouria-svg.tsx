'use client';

import { useId, useRef } from 'react';

import type { MascotMood } from '@workforce/shared';

import styles from './mascot.module.css';
import { useLipSync, type TalkShape } from './use-lip-sync';

/*
 * Nouria (نورية): chibi cartoon girl drawn as inline SVG (works offline, scales crisply).
 * Full figure viewBox is 0 0 205 322; the minimised view crops to the head.
 * Animated parts are inner <g>s without a transform attribute (CSS transforms would replace it).
 */

const INK = '#3A1A4F'; // outline
const OUT = 2.6; // outline width
const SKIN = '#FDE3D5';
const SKIN_SHADE = '#F3C2B0';
const EYE = '#2A1433';
const SHIRT = '#7C6B9E';
const SHIRT_SHADE = '#6A5A8C';
const PANTS = '#D5C9EE';
const PANTS_SHADE = '#BCAEDD';
const BOW = '#F2386E';
const BOW_SHADE = '#C51F57';
const HEART = '#EF2D5E';
const MOUTH_IN = '#701437';
const TONGUE = '#F37597';

type MouthShape = TalkShape | 'smirk' | 'o' | 'tiny' | 'frown';

const MOUTH: Record<MouthShape, { d: string; filled: boolean; teeth?: number; tongue?: number }> = {
  closed: { d: 'M-9,-2 C-4,3 4,3 9,-3', filled: false },
  smirk: { d: 'M-8,-1 C-3,3 4,2.5 9,-4', filled: false },
  frown: { d: 'M-7,3 C-3,-2 3,-2 7,2.5', filled: false },
  small: { d: 'M-8,-2 C-3,-1 3,-1.5 8,-3 C6,4.5 -4,5.5 -8,-2 Z', filled: true, tongue: 3.4 },
  open: { d: 'M-10,-3 C-4,-2 4,-2.5 10,-4.5 C8,8 -6,10 -10,-3 Z', filled: true, teeth: 3.2, tongue: 6 },
  wide: { d: 'M-11,-4 C-4,-3 4,-3.5 11,-5.5 C10,12.5 -8,15 -11,-4 Z', filled: true, teeth: 3.6, tongue: 8.6 },
  o: { d: 'M0,-5 C4,-5 5,0 4.5,3 C4,6.5 -4,6.5 -4.5,3 C-5,0 -4,-5 0,-5 Z', filled: true, tongue: 4.5 },
  tiny: { d: 'M-3,0 C-2,-2 2,-2 3,0 C2,2 -2,2 -3,0 Z', filled: true },
};

const RESTING: Record<MascotMood, MouthShape> = {
  happy: 'open', party: 'wide', wink: 'smirk', shocked: 'o', sleepy: 'tiny', sad: 'frown',
};

function Mouth({ shape, clipId }: { shape: MouthShape; clipId: string }) {
  const m = MOUTH[shape];
  if (!m.filled) return <path d={m.d} fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />;
  return (
    <>
      <defs>
        <clipPath id={clipId}><path d={m.d} /></clipPath>
      </defs>
      <path d={m.d} fill={MOUTH_IN} />
      <g clipPath={`url(#${clipId})`}>
        {m.teeth && <rect x="-12" y="-8" width="24" height={m.teeth + 4} fill="#fff" />}
        {m.tongue && <ellipse cx="1" cy={m.tongue} rx="6.5" ry="4.2" fill={TONGUE} />}
      </g>
      <path d={m.d} fill="none" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
    </>
  );
}

type EyeKind = 'open' | 'closed' | 'happy' | 'wide' | 'down';
const ALMOND = 'M-9,1 C-6,-6 5,-7.5 9,-2 C7,4 -3,6.5 -9,1 Z';

/** One eye in local coordinates; the outer corner is on the left (mirrored for her other eye). */
function Eye({ kind, clipId }: { kind: EyeKind; clipId: string }) {
  if (kind === 'closed') {
    return (
      <>
        <path d="M-9,0 C-4,4.5 4,4.5 9,0" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
        <path d="M-8.5,1 L-12,2.5" stroke={INK} strokeWidth={2} strokeLinecap="round" />
      </>
    );
  }
  if (kind === 'happy') {
    return (
      <>
        <path d="M-9,3 C-4,-5 4,-5 9,3" fill="none" stroke={INK} strokeWidth={2.8} strokeLinecap="round" />
        <path d="M-8.5,1.5 L-12,-0.5" stroke={INK} strokeWidth={2} strokeLinecap="round" />
      </>
    );
  }
  if (kind === 'wide') {
    return (
      <>
        <circle r="7.2" fill="#fff" stroke={INK} strokeWidth={2.2} />
        <circle cx="0.5" r="3.6" fill={EYE} />
        <circle cx="1.8" cy="-1.4" r="1.3" fill="#fff" />
        <path d="M-7,-5 L-10.5,-7.5" stroke={INK} strokeWidth={2} strokeLinecap="round" />
      </>
    );
  }
  const dy = kind === 'down' ? 1.6 : 0.5;
  return (
    <>
      <defs>
        <clipPath id={clipId}><path d={ALMOND} /></clipPath>
      </defs>
      <path d={ALMOND} fill="#fff" />
      <g clipPath={`url(#${clipId})`}>
        <circle cx="1" cy={dy} r="4.9" fill={EYE} />
        <circle cx="1" cy={dy} r="2.3" fill="#4B2763" />
        <circle cx="2.8" cy={dy - 2} r="1.6" fill="#fff" />
        <circle cx="-0.8" cy={dy + 2.2} r="0.7" fill="#fff" />
      </g>
      <path d="M-6,4.6 C-2,6.2 3,5.6 6.5,2.8" fill="none" stroke={INK} strokeWidth={0.9} opacity={0.5} strokeLinecap="round" />
      <path d="M-10.5,1.5 C-7,-6.5 5,-8.5 9.5,-2.5" fill="none" stroke={INK} strokeWidth={2.8} strokeLinecap="round" />
      <path d="M-9.6,0 L-13.2,-2.4 M-8.2,-2.8 L-11.2,-5.8" stroke={INK} strokeWidth={1.9} strokeLinecap="round" />
    </>
  );
}

function eyesFor(mood: MascotMood): [EyeKind, EyeKind] {
  switch (mood) {
    case 'wink': return ['open', 'happy'];
    case 'shocked': return ['wide', 'wide'];
    case 'sleepy': return ['closed', 'closed'];
    case 'party': return ['happy', 'happy'];
    case 'sad': return ['down', 'down'];
    default: return ['open', 'open'];
  }
}

const BROWS: Record<'normal' | 'up' | 'sad' | 'relaxed', [string, string]> = {
  normal: ['M52,86 C57,79 67,78 76,82', 'M98,80 C104,74 114,74 121,79'],
  up: ['M51,80 C56,73 67,72 76,76', 'M98,74 C104,68 114,68 121,72'],
  sad: ['M52,85 C60,85 69,83 76,77', 'M98,75 C105,78 113,81 121,82'],
  relaxed: ['M53,88 C59,85 67,84 75,86', 'M99,83 C105,81 113,81 120,83'],
};
const browsFor = (mood: MascotMood) => (mood === 'shocked' ? BROWS.up : mood === 'sad' ? BROWS.sad : mood === 'sleepy' ? BROWS.relaxed : BROWS.normal);

const HAIR_BACK =
  'M80,5 C52,3 33,18 28,32 C15,45 8,70 12,92 C14,105 18,112 14,122 C10,135 18,147 28,152 ' +
  'C22,161 30,174 44,178 C56,181 64,173 68,164 C71,158 74,155 76,152 L80,140 L100,140 L104,150 ' +
  'C107,158 110,165 114,171 C119,179 130,182 139,176 C148,170 150,161 146,153 C156,143 160,129 154,116 ' +
  'C162,102 166,82 160,62 C156,40 148,26 136,16 C120,4 100,4 80,5 Z';
const BANGS =
  'M33,100 C26,62 46,22 80,18 C114,15 140,42 134,96 C131,86 127,78 121,71 C117,67 112,64 107,63 ' +
  'C104,60 100,58 95,58 C89,57 83,58 78,57 C71,61 63,64 57,70 C50,77 46,86 44,96 C42,100 37,103 33,100 Z';
const LOCK_L = 'M35,94 C30,107 37,118 33,130 C40,127 46,118 46,107 C46,101 44,97 41,93 Z';
const LOCK_R = 'M133,86 C137,99 131,111 134,122 C127,119 124,109 125,99 C126,94 128,90 130,86 Z';
const FACE = 'M42,72 C37,92 39,114 50,129 C60,141 74,148 88,147 C104,146 117,135 123,120 C128,106 128,86 124,66 C110,50 60,48 42,72 Z';

export function NouriaSvg({ mood, talking = false, compact = false }: { mood: MascotMood; talking?: boolean; compact?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  const talkShape = useLipSync(talking && !compact, svgRef);
  const mouth: MouthShape = talkShape ?? RESTING[mood];
  const [eyeL, eyeR] = eyesFor(mood);
  const [browL, browR] = browsFor(mood);
  const hair = `${uid}-hair`;

  return (
    <svg
      ref={svgRef}
      viewBox={compact ? '6 0 164 182' : '0 0 205 322'}
      width="100%"
      height="100%"
      aria-hidden="true"
      data-mood={mood}
      data-mouth={mouth}
      overflow="hidden"
    >
      <defs>
        <linearGradient id={hair} gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="164" y2="0">
          <stop offset="0" stopColor="#8E5CF6" />
          <stop offset="0.3" stopColor="#9B55EA" />
          <stop offset="0.5" stopColor="#B23CC4" />
          <stop offset="0.7" stopColor="#EC3A9C" />
          <stop offset="1" stopColor="#FF5AAE" />
        </linearGradient>
        <linearGradient id={`${hair}-shade`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="70">
          <stop offset="0" stopColor="#4A1366" stopOpacity="0.45" />
          <stop offset="1" stopColor="#4A1366" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className={styles.figure}>
        {!compact && (
          <g strokeLinejoin="round">
            {/* shoes (back one first) */}
            <path d="M111,280 C109,293 111,302 117,305 C126,308 136,305 139,298 C141,290 140,284 139,278 Z" fill="#fff" stroke={INK} strokeWidth={OUT} />
            <path d="M111,298 C118,306 132,306 139,297 L139,300 C134,309 117,310 111,302 Z" fill="#D9D1EA" />
            <path d="M75,284 C73,299 74,311 80,315 C90,320 104,319 110,312 C112,302 110,292 107,284 Z" fill="#fff" stroke={INK} strokeWidth={OUT} />
            <path d="M75.5,308 C84,317 104,317 110.5,309 L110,313 C103,321 84,321 76,313 Z" fill="#D9D1EA" />
            {/* trousers */}
            <path d="M70,219 L144,219 C146,240 144,264 141,282 L112,284 L109,252 L106,288 L76,288 C72,264 69,240 70,219 Z" fill={PANTS} stroke={INK} strokeWidth={OUT} />
            <path d="M106,288 L109,252 L112,284 C110,270 109,262 108,256 Z" fill={PANTS_SHADE} />
            <path d="M132,226 C136,245 136,264 134,281 L141,282 C144,264 146,242 144,222 Z" fill={PANTS_SHADE} opacity={0.8} />
            {/* her right arm, hanging down */}
            <path d="M55,194 C52,211 50,227 52,240 C53,251 65,253 67,244 C69,232 68,214 69,199 Z" fill={SKIN} stroke={INK} strokeWidth={OUT} />
            <path d="M56,243 C58,247 62,247 64,244" fill="none" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
            {/* her left arm up to the wrist (the peace hand is drawn over the hair) */}
            <path d="M146,189 C156,193 166,197 173,195 C179,192 178,184 175,175 C172,165 168,154 166,143 L153,145 C156,157 160,170 162,181 C157,182 151,180 147,178 Z" fill={SKIN} stroke={INK} strokeWidth={OUT} />
            <path d="M163,181 C167,185 171,186 174,184" fill="none" stroke={SKIN_SHADE} strokeWidth={2} strokeLinecap="round" />
            {/* neck */}
            <path d="M79,136 L79,170 C85,176 96,175 101,168 L101,136 Z" fill={SKIN} stroke={INK} strokeWidth={OUT} />
            <path d="M80,146 C86,152 95,152 100,146 L100,138 L80,138 Z" fill={SKIN_SHADE} />
            {/* t-shirt */}
            <path d="M78,164 C70,165 62,168 58,174 C55,181 53,190 53,197 L69,200 L69,222 C90,227 125,227 146,221 L143,191 L153,188 C152,180 149,171 142,166 C130,162 112,162 101,162 C97,170 84,171 78,164 Z" fill={SHIRT} stroke={INK} strokeWidth={OUT} />
            <path d="M69,200 L69,222 C76,224 82,225 88,225 C80,218 74,208 72,199 Z" fill={SHIRT_SHADE} />
            <path d="M143,191 L146,221 C140,222 135,223 130,224 C137,214 140,202 141,191 Z" fill={SHIRT_SHADE} />
            <path d="M118,205 C124,208 132,207 138,203" fill="none" stroke={INK} strokeWidth={1.2} strokeLinecap="round" opacity={0.5} />
          </g>
        )}

        {/* head: bobs/tilts around the neck */}
        <g className={styles.head}>
          <g className={styles.hair}>
            <path d={HAIR_BACK} fill={`url(#${hair})`} stroke={INK} strokeWidth={OUT} strokeLinejoin="round" />
            <path d="M22,58 C14,80 22,96 17,114 M30,122 C24,136 30,150 40,160 M150,56 C159,76 152,96 156,112 M146,128 C150,142 144,156 134,166" fill="none" stroke={INK} strokeWidth={1.3} strokeLinecap="round" opacity={0.45} />
            <path d="M20,70 C17,84 21,94 19,104" fill="none" stroke="#C9A6FF" strokeWidth={2.4} strokeLinecap="round" opacity={0.7} />
            <path d="M155,70 C159,84 156,96 158,106" fill="none" stroke="#FFA6D3" strokeWidth={2.4} strokeLinecap="round" opacity={0.7} />
          </g>
          {/* face */}
          <path d={FACE} fill={SKIN} stroke={INK} strokeWidth={OUT} strokeLinejoin="round" />
          <defs>
            <clipPath id={`${uid}-face`}><path d={FACE} /></clipPath>
          </defs>
          <g clipPath={`url(#${uid}-face)`}>
            <path d={BANGS} transform="translate(1 4)" fill={SKIN_SHADE} />
          </g>
          <ellipse cx="55" cy="117" rx="7" ry="4" fill="#F7A0B6" opacity={0.55} />
          <ellipse cx="117" cy="110" rx="5.5" ry="3.6" fill="#F7A0B6" opacity={0.55} />
          {/* brows */}
          <path d={browL} fill="none" stroke={EYE} strokeWidth={3.4} strokeLinecap="round" />
          <path d={browR} fill="none" stroke={EYE} strokeWidth={3.2} strokeLinecap="round" />
          {/* eyes */}
          <g transform="translate(64 101) scale(1.25)">
            <g className={styles.blink}><Eye kind={eyeL} clipId={`${uid}-eyeL`} /></g>
          </g>
          <g transform="translate(108.5 95) scale(-1.15 1.18)">
            <g className={styles.blink}><Eye kind={eyeR} clipId={`${uid}-eyeR`} /></g>
          </g>
          {/* nose */}
          <path d="M91,108 C93,111.5 92,114.5 88.5,114" fill="none" stroke={INK} strokeWidth={1.8} strokeLinecap="round" />
          {/* mouth */}
          <g transform="translate(95 127)">
            <g className={styles.mouth}><Mouth shape={mouth} clipId={`${uid}-mouth`} /></g>
          </g>
          {/* bangs + parting */}
          <path d={BANGS} fill={`url(#${hair})`} stroke={INK} strokeWidth={OUT} strokeLinejoin="round" />
          <path d={BANGS} fill={`url(#${hair}-shade)`} />
          <path d={LOCK_L} fill={`url(#${hair})`} stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
          <path d={LOCK_R} fill={`url(#${hair})`} stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
          <path d="M79,19 C76,32 76,45 78,56 M66,26 C56,38 50,55 46,80 M101,24 C112,34 120,48 124,64" fill="none" stroke={INK} strokeWidth={1.3} strokeLinecap="round" opacity={0.5} />
          <path d="M60,32 C52,42 47,54 45,66" fill="none" stroke="#D4B3FF" strokeWidth={2.4} strokeLinecap="round" opacity={0.6} />
          <path d="M106,28 C116,36 122,46 126,58" fill="none" stroke="#FFB3DA" strokeWidth={2.4} strokeLinecap="round" opacity={0.6} />
          {/* bow */}
          <g strokeLinejoin="round">
            <path d="M131,26 L123,42 L129,39 L132,44 L135,27 Z" fill={BOW_SHADE} stroke={INK} strokeWidth={2.2} />
            <path d="M134,25 L147,37 L141,37 L141,43 L132,28 Z" fill={BOW_SHADE} stroke={INK} strokeWidth={2.2} />
            <path d="M132,23 C121,8 107,10 111,23 C113,32 124,29 132,23 Z" fill={BOW} stroke={INK} strokeWidth={2.2} />
            <path d="M132,23 C141,6 156,10 152,23 C150,32 140,29 132,23 Z" fill={BOW} stroke={INK} strokeWidth={2.2} />
            <path d="M114,20 C117,16 122,16 125,19 M140,18 C143,14 148,14 150,18" fill="none" stroke="#FF8AAE" strokeWidth={1.6} strokeLinecap="round" />
            <circle cx="132" cy="23.5" r="5" fill={BOW} stroke={INK} strokeWidth={2.2} />
          </g>
        </g>

        {!compact && (
          /* peace-sign hand, wiggles around the wrist */
          <g className={styles.peace} strokeLinecap="round">
            <path d="M151,130 L135,114 M156,126 L149,106" stroke={INK} strokeWidth={8} />
            <path d="M151,130 L135,114 M156,126 L149,106" stroke={SKIN} strokeWidth={3.2} />
            <path d="M152,147 C146,141 145,131 149,126 C153,120 163,121 167,127 C170,134 169,143 165,148 Z" fill={SKIN} stroke={INK} strokeWidth={OUT} strokeLinejoin="round" />
            <circle cx="167" cy="131" r="3.6" fill={SKIN} stroke={INK} strokeWidth={2} />
            <circle cx="166" cy="138.5" r="3.4" fill={SKIN} stroke={INK} strokeWidth={2} />
            <path d="M149,141 L158,133" stroke={INK} strokeWidth={7} />
            <path d="M149,141 L158,133" stroke={SKIN} strokeWidth={2.6} />
          </g>
        )}
      </g>

      {!compact && mood !== 'sleepy' && (
        <g className={styles.heart}>
          <g className={styles.heartPop}>
            <path d="M174,42 L166,52 L179,46 Z" fill="#fff" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
            <circle cx="184" cy="33" r="14" fill="#fff" stroke={INK} strokeWidth={2.2} />
            <path d="M172,43 L178,46" stroke="#fff" strokeWidth={3} />
            <path d="M184,40 C176,35 176.5,27.5 180.8,27.6 C182.4,27.6 183.6,28.8 184,30.2 C184.4,28.8 185.6,27.6 187.2,27.6 C191.5,27.5 192,35 184,40 Z" fill={HEART} />
          </g>
        </g>
      )}

      {!compact && mood === 'sleepy' && (
        <g fill="#8E5CF6" fontWeight="800" fontFamily="system-ui, sans-serif">
          <text className={styles.zzz} x="160" y="44" fontSize="18">z</text>
          <text className={`${styles.zzz} ${styles.zzz2}`} x="176" y="26" fontSize="13">z</text>
        </g>
      )}
      {compact && mood === 'sleepy' && (
        <text className={styles.zzz} x="150" y="40" fontSize="22" fontWeight="800" fill="#8E5CF6" fontFamily="system-ui, sans-serif">z</text>
      )}

      {!compact && mood === 'party' && (
        <g className={styles.confetti}>
          <rect x="16" y="20" width="7" height="7" fill="#F2386E" transform="rotate(20 19 23)" />
          <rect x="176" y="70" width="7" height="7" fill="#8E5CF6" transform="rotate(-25 179 73)" />
          <circle cx="8" cy="140" r="3.5" fill="#FFC93C" />
          <circle cx="190" cy="120" r="3.5" fill="#3FB8F0" />
          <rect x="30" y="200" width="6" height="6" fill="#FFC93C" transform="rotate(35 33 203)" />
          <circle cx="186" cy="160" r="3" fill="#F2386E" />
        </g>
      )}
    </svg>
  );
}
