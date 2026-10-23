import { createHmac, timingSafeEqual } from 'node:crypto';

// App session codes and cookies: stateless HMAC tokens carrying the opaque app user id, never the account id.

export interface AppSession {
  appSlug: string;
  /** Opaque per-app user id; the account id never rides here. */
  appUserId: string;
  /** True when the signed-in account owns the app. */
  owner: boolean;
  exp: number;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');

function sign(secret: string, payload: string): string {
  return b64u(createHmac('sha256', secret).update(payload).digest());
}

export function mintSessionCode(
  secret: string,
  input: { appSlug: string; appUserId: string; owner: boolean; ttlMs?: number },
): string {
  const exp = Date.now() + (input.ttlMs ?? 12 * 60 * 60 * 1000);
  const payload = b64u(Buffer.from(JSON.stringify({
    v: 1, a: input.appSlug, u: input.appUserId, o: input.owner ? 1 : 0, exp,
  }), 'utf8'));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySessionCode(secret: string, code: string): AppSession | null {
  const dot = code.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = code.slice(0, dot);
  const sig = code.slice(dot + 1);
  const expected = sign(secret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: unknown; a?: unknown; u?: unknown; o?: unknown; exp?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.a !== 'string' || typeof parsed.u !== 'string') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return { appSlug: parsed.a, appUserId: parsed.u, owner: parsed.o === 1, exp: parsed.exp };
  } catch {
    return null;
  }
}

/** The cookie the app host sets at the `?tsession=` exchange. */
export const SESSION_COOKIE = 'tsession';

export function sessionFromCookieHeader(
  secret: string, cookieHeader: string | undefined, appSlug: string,
): AppSession | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const session = verifySessionCode(secret, part.slice(eq + 1).trim());
    if (session !== null && session.appSlug === appSlug) return session;
  }
  return null;
}

export function sessionCookieValue(code: string, secure: boolean, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${code}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
