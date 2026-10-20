import { LoginAttemptLimiter } from './login-attempts';

describe('LoginAttemptLimiter', () => {
  it('locks a (username, IP) pair after max failures for lockMinutes, independent of other IPs', () => {
    const l = new LoginAttemptLimiter();
    const t0 = 1_000_000;
    for (let i = 1; i < 5; i++) expect(l.registerFailure('Bob', '10.0.0.1', 5, 15, t0 + i).newlyLocked).toBe(false);
    const fifth = l.registerFailure('bob', '10.0.0.1', 5, 15, t0 + 5);
    expect(fifth.newlyLocked).toBe(true);
    expect(l.lockedUntil('bob', '10.0.0.1', t0 + 6)).not.toBeNull();
    expect(l.lockedUntil('bob', '10.0.0.2', t0 + 6)).toBeNull();
    // Further failures while locked do not extend the lock.
    expect(l.registerFailure('bob', '10.0.0.1', 5, 15, t0 + 10).newlyLocked).toBe(false);
    expect(l.lockedUntil('bob', '10.0.0.1', t0 + 5 + 15 * 60_000 + 1)).toBeNull();
  });

  it('forgets failures older than the window and on clear()', () => {
    const l = new LoginAttemptLimiter();
    for (let i = 0; i < 4; i++) l.registerFailure('amy', 'ip', 5, 1, i);
    // Window (1 minute) passed: counting restarts.
    expect(l.registerFailure('amy', 'ip', 5, 1, 61_000).newlyLocked).toBe(false);
    for (let i = 0; i < 3; i++) l.registerFailure('amy', 'ip', 5, 1, 61_001 + i);
    l.clear('amy', 'ip');
    expect(l.registerFailure('amy', 'ip', 5, 1, 61_010).newlyLocked).toBe(false);
  });
});
