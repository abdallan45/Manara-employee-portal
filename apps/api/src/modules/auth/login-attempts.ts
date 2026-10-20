import { Injectable } from '@nestjs/common';

interface Entry {
  /** Failures counted in the current window. */
  count: number;
  /** When the current counting window ends (failures older than this are forgotten). */
  windowEndsAt: number;
  /** While in the future, this (username, IP) pair is locked. */
  lockedUntil: number;
}

/** Hard cap so a spray of random usernames cannot grow the map without bound; oldest entries go first. */
const MAX_ENTRIES = 50_000;

/**
 * Failed sign-in attempts per (username, client IP).
 *
 * After `max` failures inside `lockMinutes`, that pair is locked for `lockMinutes`. Locking per pair means an
 * attacker hammering a username from one address cannot lock the real user out from their own device.
 *
 * Kept in process memory: this is a single-server deployment, so one map sees every attempt. State is lost on
 * restart (an attacker gains at most one extra burst per restart) and would have to move to the database or a
 * shared store if the API is ever run as several instances. The per-user database counter in AuthService is
 * the cross-IP backstop.
 */
@Injectable()
export class LoginAttemptLimiter {
  private readonly entries = new Map<string, Entry>();

  private key(username: string, ip: string): string {
    return `${username.trim().toLowerCase()}\u0000${ip}`;
  }

  private live(key: string, now: number): Entry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.lockedUntil <= now && e.windowEndsAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** The lock expiry for this pair, or null when it is not locked. */
  lockedUntil(username: string, ip: string, now = Date.now()): Date | null {
    const e = this.live(this.key(username, ip), now);
    return e && e.lockedUntil > now ? new Date(e.lockedUntil) : null;
  }

  /**
   * Records one failure. Returns the pair's lock expiry if it is locked after this attempt, and whether this
   * attempt is the one that started the lock.
   */
  registerFailure(username: string, ip: string, max: number, lockMinutes: number, now = Date.now()): { lockedUntil: Date | null; newlyLocked: boolean } {
    const key = this.key(username, ip);
    const windowMs = lockMinutes * 60_000;
    let e = this.live(key, now);
    if (e && e.lockedUntil > now) return { lockedUntil: new Date(e.lockedUntil), newlyLocked: false };
    if (!e || e.windowEndsAt <= now) {
      e = { count: 0, windowEndsAt: now + windowMs, lockedUntil: 0 };
    }
    e.count += 1;
    let newlyLocked = false;
    if (e.count >= max) {
      e.lockedUntil = now + windowMs;
      e.windowEndsAt = e.lockedUntil;
      e.count = 0;
      newlyLocked = true;
    }
    this.entries.delete(key); // re-insert so Map order approximates recency for the size cap
    this.entries.set(key, e);
    this.enforceCap(now);
    return { lockedUntil: e.lockedUntil > now ? new Date(e.lockedUntil) : null, newlyLocked };
  }

  /** Forgets the pair (after a successful sign-in). */
  clear(username: string, ip: string): void {
    this.entries.delete(this.key(username, ip));
  }

  /** Test hook. */
  reset(): void {
    this.entries.clear();
  }

  private enforceCap(now: number): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && e.windowEndsAt <= now) this.entries.delete(k);
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
