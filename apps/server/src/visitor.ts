import type { IncomingMessage } from 'node:http';

/** Visitor walls: per-IP rate limits + request caps + declared-actions-only surface. */

export const MAX_ACT_BODY_BYTES = 32 * 1024;
export const ACT_RATE_LIMIT = 30; // per IP per window
export const ACT_RATE_WINDOW_MS = 60_000;

export interface RateLimiter {
  /** true = allowed; false = over the window's budget (the caller answers 429). */
  allow(key: string, now?: number): boolean;
}

/** Fixed-window per-key limiter: small, predictable, no timers to leak. */
export function createRateLimiter(opts?: { limit?: number; windowMs?: number }): RateLimiter {
  const limit = opts?.limit ?? ACT_RATE_LIMIT;
  const windowMs = opts?.windowMs ?? ACT_RATE_WINDOW_MS;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        // Opportunistic sweep: prevents unbounded growth under IP churn.
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
        }
        return true;
      }
      w.count += 1;
      return w.count <= limit;
    },
  };
}

/** Client key: direct socket address only (proxy header trust is a deployment concern). */
export function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Reads request body up to cap bytes; resolves null when cap is crossed (caller answers 413). */
export function readBodyCapped(req: IncomingMessage, cap: number = MAX_ACT_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > cap) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
