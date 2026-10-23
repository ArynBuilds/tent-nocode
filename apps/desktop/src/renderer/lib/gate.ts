import type { AuthState } from '../../shared/ipc.js';

/**
 * The onboarding gate's pure step logic: until 'open' the app renders the gate and nothing else.
 * Steps derive from the live account state, never stored.
 */
export type GateStep = 'loading' | 'sign-up' | 'unlock' | 'open';

export function gateStep(auth: AuthState | null): GateStep {
  if (auth === null) return 'loading';
  if (auth.status === 'needs-sign-up') return 'sign-up';
  if (auth.status === 'signed-out') return 'unlock';
  return 'open';
}
