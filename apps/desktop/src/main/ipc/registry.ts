import { ipcMain } from 'electron';
import type { DeskAction } from '../../shared/roles.js';
import { can } from '../../shared/roles.js';
import { getIdentity, resolveIdentity, type Identity } from '../identity.js';
import { authState } from '../account.js';
import { SIGN_IN_WORKSPACE, workspaceCall } from '../workspaceClient.js';
import type { DeskInvokeChannel, MutationResult } from '../../shared/ipc.js';

// The one ipcMain.handle wrapper for the desktop-NATIVE set: identity, org scoping, role gate, and error scrubbing.
// roles: [] registers a read (no role gate, raw return); roles: [...] a mutation ({ ok } envelope).
// The router adapter (adapter.ts) forwards every other channel and skips the names registered here.

/** Every channel the native set registered; the adapter leaves these alone. */
export const nativeChannels = new Set<string>();

/** Channels that answer with or without a session; their fns ignore identity. */
const DEVICE_LOCAL = new Set<DeskInvokeChannel>([
  'authState', 'signUp', 'signIn', 'signOut', 'windowControl', 'focusedScene',
  'takePendingPackageOffer',
  'panelBrowserGuest', 'panelBrowserState', 'panelBrowserUserAction',
]);

// Identity resolves lazily: signed-in but unresolved resolves now; DEVICE_LOCAL answers regardless.
async function identityFor(channel: DeskInvokeChannel): Promise<Identity | null> {
  try {
    return getIdentity();
  } catch {
    if (DEVICE_LOCAL.has(channel)) return null;
    if (authState().status !== 'signed-in') throw new Error(SIGN_IN_WORKSPACE);
    return resolveIdentity(workspaceCall);
  }
}

export function handle<A extends unknown[], R>(
  channel: DeskInvokeChannel,
  roles: DeskAction[],
  fn: (identity: Identity, ...args: A) => Promise<R>,
): void {
  const isMutation = roles.length > 0;
  nativeChannels.add(channel);

  ipcMain.handle(channel, async (_event, ...args: A): Promise<R | MutationResult<R>> => {
    let identity: Identity;
    try {
      // DEVICE_LOCAL null rides as the cast; those fns never read it.
      identity = (await identityFor(channel)) as Identity;
    } catch (err) {
      if (!isMutation) throw err;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!isMutation) {
      // Reads are not role-gated; they still scope through the local identity.
      return fn(identity, ...args);
    }

    try {
      const allowed = roles.some((action) => can(identity.role, action));
      if (!allowed) {
        return { ok: false, error: `role '${identity.role}' is not permitted to perform '${channel}'` };
      }
      const data = await fn(identity, ...args);
      return { ok: true, data };
    } catch (err) {
      // Never leak a stack trace to the renderer.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });
}

/** Throws when a caller-supplied orgId does not match the resolved identity. */
export function assertOwnOrg(identity: Identity, orgId: string): void {
  if (identity.orgId !== orgId) {
    throw new Error('not authorized for this org');
  }
}
