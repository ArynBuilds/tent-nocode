import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthState } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { gateStep } from '../../lib/gate.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import { navigate } from '../../lib/router.js';
import { OnboardingGate } from '../onboarding/OnboardingGate.js';
import { FocusedShell } from './FocusedShell.js';
import styles from './shell.module.css';

// Onboarding gate outranks all shells; queues pending package offers until gate opens.
export function GateOrShell({ focus, onExitFocus, shell }: {
  focus: { slug: string; viaLaunch: boolean } | null;
  onExitFocus: () => void;
  // Authoring shell element passed in; this component owns the gate.
  shell: ReactNode;
}) {
  const { orgId } = useOrg();
  const { focusProject } = useFocusedProject();
  const [auth, setAuth] = useState<AuthState | null>(null);

  useEffect(() => {
    desk.authState().then(setAuth).catch(() => undefined);
    const bridge = (window as unknown as { desk?: { onAuth?: (cb: (s: AuthState) => void) => () => void } }).desk;
    const off = bridge?.onAuth?.(setAuth);
    return () => off?.();
  }, []);

  const [pendingPackage, setPendingPackage] = useState<string | null>(null);
  useEffect(() => {
    desk.takePendingPackageOffer()
      .then((path) => { if (path !== null) setPendingPackage(path); })
      .catch(() => undefined);
    const bridge = (window as unknown as { desk?: { onOpenPackage?: (cb: (path: string) => void) => () => void } }).desk;
    const off = bridge?.onOpenPackage?.((path) => setPendingPackage(path));
    return () => off?.();
  }, []);

  const step = gateStep(auth);

  useEffect(() => {
    if (pendingPackage === null || step !== 'open') return;
    const path = pendingPackage;
    setPendingPackage(null);
    // The same import the app's own Import door runs; the landed project takes focus.
    void desk.humanImportFile(orgId, path).then((res) => {
      if (res.ok && res.data?.lane === 'package' && res.data.projectId !== undefined) focusProject(res.data.projectId);
    }).catch(() => undefined);
  }, [pendingPackage, step, orgId, focusProject]);

  if (step === 'open') {
    // A --focus-scene launch: the window is the focused shell; no authoring shell beneath.
    if (focus !== null && focus.viaLaunch) {
      return <FocusedShell slug={focus.slug} onExit={null} />;
    }
    // The Play surface overlays the shell; it stays mounted beneath.
    return (
      <>
        {shell}
        {focus !== null ? (
          <div className={styles.focusedOverlay}>
            <FocusedShell slug={focus.slug} onExit={onExitFocus} />
          </div>
        ) : null}
      </>
    );
  }
  return <OnboardingGate step={step} auth={auth} />;
}
