import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthState, IdentityDto } from '../../shared/ipc.js';
import { desk } from './desk.js';
import { getIdentity, resetIdentity } from './identity.js';

/**
 * The resolved identity, provided once at the root and read by every screen.
 * Auth-aware: before sign-up or while locked it provides the GUEST sentinel so
 * the onboarding gate can render; a sign-in push re-asks; a failed ask retries
 * quietly and speaks its one sentence only while genuinely signed in.
 */
export type OrgContextValue = IdentityDto;

/** Not signed in: the gate owns the screen; no org surface renders behind it. */
const GUEST: IdentityDto = { userId: '', orgId: '', role: 'owner', displayName: '', email: '' };

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<IdentityDto | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [auth, setAuth] = useState<AuthState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ask = (): void => {
      getIdentity()
        .then((value) => {
          if (cancelled) return;
          setIdentity(value);
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          // The race heals itself: the door answers once the identity
          // lands - one quiet retry beat, never a poisoned session.
          window.setTimeout(() => { if (!cancelled) ask(); }, 1_500);
        });
    };
    // The identity exists only once unlocked; a locked app asks nothing.
    void desk.authState().then((s) => {
      if (cancelled) return;
      setAuth(s);
      if (s.status === 'signed-in') ask();
    }).catch(() => undefined);
    const bridge = (window as unknown as { desk?: { onAuth?: (cb: (s: AuthState) => void) => () => void } }).desk;
    const off = bridge?.onAuth?.((state) => {
      if (cancelled) return;
      setAuth(state);
      if (state.status === 'signed-in') {
        resetIdentity();
        ask();
      } else {
        setIdentity(undefined);
        setError(undefined);
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  if (identity !== undefined) {
    return <OrgContext.Provider value={identity}>{children}</OrgContext.Provider>;
  }
  if (auth === null || auth.status !== 'signed-in') {
    // Not signed in (or auth still resolving): the gate renders and owns the
    // screen - the guest sentinel exists so hooks resolve, nothing more.
    return <OrgContext.Provider value={GUEST}>{children}</OrgContext.Provider>;
  }
  if (error !== undefined) {
    return <div className="desk-boot__label">identity failed to load: {error}</div>;
  }
  // Signed in, first resolve in flight - brief.
  return null;
}

/** Reads the resolved identity. Throws if called outside `OrgProvider` — every screen renders inside it. */
export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) {
    throw new Error('useOrg() called outside OrgProvider');
  }
  return value;
}
