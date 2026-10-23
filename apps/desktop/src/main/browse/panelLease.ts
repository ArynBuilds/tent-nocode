// Pure panel-browser lease state machine: single holder, revoked stays revoked, only the user resumes, hand_back pauses every verb.

export interface PanelLease {
  runId: string;
  orgId: string;
  task: string;
  /** 'agent' = the holder drives; 'user' = handed back, verbs pause. */
  mode: 'agent' | 'user';
  handBackReason: string | null;
}

type Emit = (type: string, payload: Record<string, unknown>) => void;

let lease: PanelLease | null = null;
let emit: Emit = () => { /* no emitter until the driver wires one */ };

export function setLeaseEmitter(e: Emit): void {
  emit = e;
}

export function leaseInfo(): PanelLease | null {
  return lease;
}

export function acquireLease(runId: string, orgId: string, task: string): { ok: true } | { ok: false; error: string } {
  if (lease !== null && lease.runId !== runId) {
    return { ok: false, error: `browser is already leased to another task ("${lease.task}") — one holder at a time` };
  }
  lease = { runId, orgId, task, mode: 'agent', handBackReason: null };
  emit('browser.lease_granted', { runId, task });
  return { ok: true };
}

export function releaseLease(runId: string): void {
  if (lease === null || lease.runId !== runId) return;
  emit('browser.lease_released', { runId });
  lease = null;
}

/** User-side revoke; revoked stays revoked. */
export function revokeLease(reason: string): void {
  if (lease === null) return;
  emit('browser.lease_revoked', { runId: lease.runId, reason });
  lease = null;
}

/** The holder hands the wheel to the user. */
export function handBackLease(runId: string, reason: string): { ok: true } | { ok: false; error: string } {
  if (lease === null || lease.runId !== runId) return { ok: false, error: 'no lease held' };
  lease = { ...lease, mode: 'user', handBackReason: reason };
  emit('browser.handed_back', { runId, reason });
  return { ok: true };
}

/** Only the user resumes; a no-op unless a hand_back is pending. */
export function resumeLease(): void {
  if (lease === null || lease.mode !== 'user') return;
  lease = { ...lease, mode: 'agent', handBackReason: null };
  emit('browser.resumed', { runId: lease.runId });
}

/** The verb gate: null = drive on; a string = the honest refusal. */
export function leaseGuard(runId: string): string | null {
  if (lease === null || lease.runId !== runId) return 'no browser lease — call acquire_browser first';
  if (lease.mode === 'user') return `the user is driving (hand_back: "${lease.handBackReason ?? ''}") — wait for them to resume`;
  return null;
}

/** Test seam only. */
export function _resetLeaseForTests(): void {
  lease = null;
  emit = () => { /* reset */ };
}
