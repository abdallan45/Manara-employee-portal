import ipaddr from 'ipaddr.js';

/** Parses an IP and unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d) to plain IPv4. */
export function parseIp(ip: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    return ipaddr.process(ip.trim().replace(/%.*$/, ''));
  } catch {
    return null;
  }
}

/** A value safe for an inet column: the client IP, or 0.0.0.0 when it cannot be parsed. */
export function inetOrZero(ip: string | null | undefined): string {
  return (ip && parseIp(ip)?.toString()) || '0.0.0.0';
}
