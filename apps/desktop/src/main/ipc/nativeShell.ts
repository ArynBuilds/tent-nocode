import { BrowserWindow } from 'electron';
import type { IdentityDto, SignUpInput } from '../../shared/ipc.js';
import { authState, signIn, signOut, signUp } from '../account.js';
import { panelLeaseInfo, resumePanelLease, revokePanelLease, setPanelGuest } from '../browse/panelDriver.js';
import { focusedScene } from '../focusState.js';
import type { Identity } from '../identity.js';
import { takePendingPackageOffer } from '../packageOffer.js';
import { latestDraftFrame } from '../scenes/draftFrameStash.js';
import { handle } from './registry.js';

// THE DEVICE: the local account, window chrome, the panel browser lease, cold-launch offers - nothing here
// reaches the workspace; identity stays local so the first read answers offline.

/** Maps the cached identity to its DTO. */
export function identityImpl(identity: Identity): IdentityDto {
  return {
    userId: identity.userId,
    orgId: identity.orgId,
    role: identity.role,
    displayName: identity.displayName,
    email: identity.email,
  };
}

export function registerShellHandlers(): void {
  handle('identity', [], async (identity) => identityImpl(identity));

  // Session channels; device-local, and tokens never cross this boundary.
  handle('authState', [], async () => authState());
  handle('signUp', [], async (_identity, input: SignUpInput) => signUp(input));
  handle('signIn', [], async (_identity, password: string) => signIn(password));
  handle('signOut', [], async () => {
    await signOut();
    return null;
  });

  // Draft-frame read; session-transient and in-memory.
  handle('latestSceneDraft', [], async (identity) => latestDraftFrame(identity.orgId));

  // Panel-browser lease controls.
  handle('panelBrowserGuest', [], async (_identity, id: number | null) => {
    setPanelGuest(typeof id === 'number' ? id : null);
    return null;
  });
  handle('panelBrowserState', [], async () => {
    const lease = panelLeaseInfo();
    return lease === null ? null : { task: lease.task, mode: lease.mode, handBackReason: lease.handBackReason };
  });
  handle('panelBrowserUserAction', [], async (_identity, action: 'revoke' | 'resume') => {
    if (action === 'revoke') revokePanelLease('revoked by the user');
    else resumePanelLease();
    return null;
  });

  handle('focusedScene', [], async () => focusedScene());

  // Cold-launch offers are read-and-clear.
  handle('takePendingPackageOffer', [], async () => takePendingPackageOffer());

  // In-frame window controls for the custom title bar.
  handle('windowControl', [], async (_identity, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
    return null;
  });
}
