import { createHmac, timingSafeEqual } from 'node:crypto';

/** The account token: HS256 over the per-install secret. The desktop mints it after the local sign-in;
 * the host verifies it. One alg pinned, iss/aud fixed, unexpired, sub = the local user id. */

export interface AccountIdentity {
  userId: string;
  email?: string;
  displayName?: string;
}

const ISSUER = 'nodeloom-desktop';
const AUDIENCE = 'nodeloom-host';

const b64url = (b: Buffer): string => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function mintAccountToken(who: AccountIdentity, secret: string, ttlSeconds: number): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify({
    iss: ISSUER, aud: AUDIENCE, sub: who.userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(who.email !== undefined ? { email: who.email } : {}),
    ...(who.displayName !== undefined ? { name: who.displayName } : {}),
  })));
  const sig = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export function verifyAccountToken(token: string, secret: string): AccountIdentity | null {
  if (secret === '') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  let header: { alg?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(head).toString('utf8')) as { alg?: unknown };
    payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = b64urlDecode(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (payload['iss'] !== ISSUER || payload['aud'] !== AUDIENCE) return null;
  if (typeof payload['exp'] !== 'number' || payload['exp'] * 1000 <= Date.now()) return null;
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub === '') return null;
  return {
    userId: sub,
    ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}),
    ...(typeof payload['name'] === 'string' ? { displayName: payload['name'] } : {}),
  };
}
