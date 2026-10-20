import { dummyPasswordHash, generateToken, hashPassword, safeEqualHex, sha256Hex, verifyPassword } from './password';

describe('password hashing', () => {
  it('hashes with Argon2id and the configured cost parameters', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    await expect(verifyPassword(h, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(h, 'correct horse batterY')).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-1'), hashPassword('same-password-1')]);
    expect(a).not.toEqual(b);
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    await expect(verifyPassword('not-a-hash', 'whatever123')).resolves.toBe(false);
  });

  it('provides a stable dummy hash for timing equalisation', async () => {
    const d = await dummyPasswordHash();
    expect(d).toMatch(/^\$argon2id\$/);
    expect(await dummyPasswordHash()).toBe(d);
  });
});

describe('tokens', () => {
  it('generates 32-byte base64url tokens', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toEqual(t);
  });

  it('compares hex digests safely', () => {
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('a'))).toBe(true);
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('b'))).toBe(false);
    expect(safeEqualHex(sha256Hex('a'), 'abcd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});
