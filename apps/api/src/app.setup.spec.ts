import { parseTrustedProxies } from './app.setup';

describe('parseTrustedProxies', () => {
  it('trusts nothing when unset or empty', () => {
    expect(parseTrustedProxies(undefined)).toBe(false);
    expect(parseTrustedProxies('')).toBe(false);
    expect(parseTrustedProxies(' , ')).toBe(false);
  });

  it('accepts IPs, CIDRs and Express keywords', () => {
    expect(parseTrustedProxies('loopback, 172.28.0.10,10.0.0.0/8, ::1')).toEqual(['loopback', '172.28.0.10', '10.0.0.0/8', '::1']);
  });

  it('rejects garbage so a typo cannot silently trust everyone', () => {
    expect(() => parseTrustedProxies('true')).toThrow(/invalid entry/);
    expect(() => parseTrustedProxies('10.0.0.0/99')).toThrow(/invalid entry/);
  });
});
