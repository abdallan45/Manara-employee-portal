import { checkAudio, parseRange, sniffAudio } from './mascot-audio';

const bytes = (...b: number[]) => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);
const ascii = (s: string) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(16)]);

describe('sniffAudio', () => {
  it('recognises the supported containers', () => {
    expect(sniffAudio(ascii('ID3\x04'))).toBe('id3');
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90, 0x64))).toBe('mpeg');
    expect(sniffAudio(bytes(0xff, 0xf3, 0x64, 0xc4))).toBe('mpeg');
    expect(sniffAudio(bytes(0xff, 0xf1, 0x50, 0x80))).toBe('adts');
    expect(sniffAudio(ascii('RIFF\x24\x00\x00\x00WAVEfmt '))).toBe('wav');
    expect(sniffAudio(ascii('OggS\x00'))).toBe('ogg');
    expect(sniffAudio(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('webm');
    expect(sniffAudio(ascii('\x00\x00\x00\x20ftypM4A '))).toBe('mp4');
  });

  it('rejects other content', () => {
    expect(sniffAudio(ascii('RIFF\x24\x00\x00\x00WEBPVP8 '))).toBeNull();
    expect(sniffAudio(ascii('%PDF-1.4'))).toBeNull();
    expect(sniffAudio(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
    expect(sniffAudio(bytes(0xff, 0xfb, 0xf0, 0x00))).toBeNull();
    expect(sniffAudio(Buffer.from([0x49]))).toBeNull();
  });
});

describe('checkAudio', () => {
  it('canonicalises the declared type and ignores parameters', () => {
    expect(checkAudio('audio/mp3', ascii('ID3\x04'))).toEqual({ mime: 'audio/mpeg' });
    expect(checkAudio('audio/x-wav', ascii('RIFF\x24\x00\x00\x00WAVE'))).toEqual({ mime: 'audio/wav' });
    expect(checkAudio('audio/webm;codecs=opus', bytes(0x1a, 0x45, 0xdf, 0xa3))).toEqual({ mime: 'audio/webm' });
    expect(checkAudio('audio/x-m4a', ascii('\x00\x00\x00\x20ftypM4A '))).toEqual({ mime: 'audio/mp4' });
  });

  it('refuses unsupported types and content that does not match the type', () => {
    expect(checkAudio('video/mp4', ascii('\x00\x00\x00\x20ftypisom'))).toHaveProperty('problem');
    expect(checkAudio(undefined, ascii('ID3'))).toHaveProperty('problem');
    expect(checkAudio('audio/mpeg', ascii('OggS\x00'))).toHaveProperty('problem');
    expect(checkAudio('audio/wav', ascii('ID3\x04'))).toHaveProperty('problem');
  });
});

describe('parseRange', () => {
  it('handles start-end, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('whole file for absent, malformed or multi-range headers; unsatisfiable past the end', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});
