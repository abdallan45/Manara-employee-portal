import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters (19 MiB, 2 passes, 1 lane).
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 as Algorithm /* Argon2id */ };

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** A real Argon2id hash of a random secret, verified against when the user does not exist so timing does not reveal it. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
}

/** 32 random bytes, base64url. */
export const generateToken = () => randomBytes(32).toString('base64url');

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}
