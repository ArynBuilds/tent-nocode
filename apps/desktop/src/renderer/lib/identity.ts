import type { IdentityDto } from '../../shared/ipc.js';
import { desk } from './desk.js';

/**
 * Caches the single `identity()` round trip for the lifetime of the
 * renderer process. There is exactly one local identity per desktop
 * install (no login, no switching orgs mid-session — see `main/identity.ts`),
 * so every caller (chiefly `OrgContext`'s provider) shares one in-flight
 * promise instead of re-invoking IPC on every mount.
 */
let cached: Promise<IdentityDto> | undefined;

export function getIdentity(): Promise<IdentityDto> {
  if (!cached) {
    const asked = desk.identity();
    cached = asked;
    // The boot-race fix (2026-08-14): a refusal is a MOMENT, never a fact -
    // caching a rejection poisoned the whole session on one lost race. The
    // next ask retries; a success stays cached for the process lifetime.
    asked.catch(() => {
      if (cached === asked) cached = undefined;
    });
  }
  return cached;
}

/** Sign-in landed: the next ask resolves the fresh account. */
export function resetIdentity(): void {
  cached = undefined;
}
