import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCsp, createCspProvider, readCspScriptHashes } from './security-headers';

const H1 = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const H2 = 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const scriptSrc = (csp: string) => csp.split('; ').find((d) => d.startsWith('script-src '));
const styleSrc = (csp: string) => csp.split('; ').find((d) => d.startsWith('style-src '));

describe('buildCsp', () => {
  it("falls back to 'unsafe-inline' without hashes", () => {
    expect(scriptSrc(buildCsp(null))).toBe("script-src 'self' 'unsafe-inline'");
  });

  it("uses 'self' plus the hashes, and leaves style-src alone", () => {
    const csp = buildCsp([H1, H2]);
    expect(scriptSrc(csp)).toBe(`script-src 'self' '${H1}' '${H2}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(styleSrc(csp)).toBe("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe('CSP provider (web build hash file)', () => {
  let dir: string;
  let clock: number;
  const logger = { warn: jest.fn(), log: jest.fn() };
  const writeHashes = (body: unknown, mtimeSec?: number) => {
    const file = join(dir, 'csp-hashes.json');
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  };
  const provider = () => createCspProvider({ candidates: [dir], checkIntervalMs: 5000, now: () => clock, logger });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csp-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    clock = 1_000_000;
    logger.warn.mockClear();
    logger.log.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('uses the hashes when the file is present', () => {
    writeHashes({ script: [H1, H2, H1] });
    expect(scriptSrc(provider()())).toBe(`script-src 'self' '${H1}' '${H2}'`);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the current policy and warns when the file is missing or invalid', () => {
    expect(scriptSrc(provider()())).toBe("script-src 'self' 'unsafe-inline'");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/csp-hashes\.json is missing/));
    for (const bad of ['not json', { script: 'x' }, { script: ["'unsafe-eval'"] }, { script: ['sha256-ok; script-src *'] }, null]) {
      writeHashes(bad);
      expect(scriptSrc(provider()())).toBe("script-src 'self' 'unsafe-inline'");
    }
  });

  it('re-reads the file when it changes, at most once per interval', () => {
    writeHashes({ script: [H1] }, 1_700_000_000);
    const csp = provider();
    expect(scriptSrc(csp())).toBe(`script-src 'self' '${H1}'`);

    // New web build: different hashes and mtime. Within the interval the cached policy stays.
    writeHashes({ script: [H2] }, 1_700_000_100);
    clock += 1000;
    expect(scriptSrc(csp())).toBe(`script-src 'self' '${H1}'`);
    clock += 5000;
    expect(scriptSrc(csp())).toBe(`script-src 'self' '${H2}'`);

    // Unchanged file: no re-read (and no log line) on later checks.
    logger.log.mockClear();
    clock += 10_000;
    expect(scriptSrc(csp())).toBe(`script-src 'self' '${H2}'`);
    expect(logger.log).not.toHaveBeenCalled();

    // File removed mid-rebuild: falls back, then picks the next build up.
    rmSync(join(dir, 'csp-hashes.json'));
    clock += 6000;
    expect(scriptSrc(csp())).toBe("script-src 'self' 'unsafe-inline'");
    writeHashes({ script: [H1, H2] }, 1_700_000_200);
    clock += 6000;
    expect(scriptSrc(csp())).toBe(`script-src 'self' '${H1}' '${H2}'`);
  });

  it('readCspScriptHashes reports a missing web build', () => {
    expect(readCspScriptHashes(null)).toEqual({ hashes: null, problem: 'web build not found' });
  });
});
