import { MASCOT_AUDIO_MIME } from '@workforce/shared';

export type AudioMime = (typeof MASCOT_AUDIO_MIME)[number];
export type AudioContainer = 'id3' | 'mpeg' | 'adts' | 'wav' | 'ogg' | 'webm' | 'mp4';

/** Container from the first bytes; the browser-supplied type is checked against this. */
export function sniffAudio(buf: Buffer): AudioContainer | null {
  if (buf.length < 4) return null;
  const ascii = (from: number, to: number) => buf.subarray(from, to).toString('latin1');
  if (ascii(0, 3) === 'ID3') return 'id3';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const layer = (buf[1] >> 1) & 0b11;
    // Layer bits 00 = ADTS (AAC); 01–11 = MPEG audio layer III/II/I.
    if (layer === 0) return (buf[1] & 0xf6) === 0xf0 ? 'adts' : null;
    const bitrate = buf[2] >> 4;
    const sampleRate = (buf[2] >> 2) & 0b11;
    return bitrate !== 0b1111 && sampleRate !== 0b11 ? 'mpeg' : null;
  }
  return null;
}

/** Canonical stored type and the containers each declared type may hold. */
const ACCEPTED: Record<AudioMime, { canonical: string; containers: AudioContainer[] }> = {
  'audio/mpeg': { canonical: 'audio/mpeg', containers: ['id3', 'mpeg'] },
  'audio/mp3': { canonical: 'audio/mpeg', containers: ['id3', 'mpeg'] },
  'audio/wav': { canonical: 'audio/wav', containers: ['wav'] },
  'audio/x-wav': { canonical: 'audio/wav', containers: ['wav'] },
  'audio/wave': { canonical: 'audio/wav', containers: ['wav'] },
  'audio/ogg': { canonical: 'audio/ogg', containers: ['ogg'] },
  'audio/webm': { canonical: 'audio/webm', containers: ['webm'] },
  'audio/mp4': { canonical: 'audio/mp4', containers: ['mp4'] },
  'audio/x-m4a': { canonical: 'audio/mp4', containers: ['mp4'] },
  'audio/aac': { canonical: 'audio/aac', containers: ['adts', 'id3'] },
};

/**
 * Stored content type for an upload, or a reason it is refused. The declared type (parameters such as
 * ";codecs=opus" ignored) must be an accepted audio type and must agree with the file's magic bytes.
 */
export function checkAudio(declared: string | undefined, buf: Buffer): { mime: string } | { problem: string } {
  const base = (declared ?? '').split(';')[0].trim().toLowerCase();
  const accepted = (ACCEPTED as Record<string, (typeof ACCEPTED)[AudioMime] | undefined>)[base];
  if (!accepted) return { problem: `Unsupported audio type "${base || 'unknown'}"; accepted: ${MASCOT_AUDIO_MIME.join(', ')}` };
  const container = sniffAudio(buf);
  if (!container || !accepted.containers.includes(container)) {
    return { problem: `The file content is not ${base} audio` };
  }
  return { mime: accepted.canonical };
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range "Range: bytes=…" header. Returns null to send the whole file (absent, malformed or
 * multi-range header) and 'unsatisfiable' for a range outside the file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
