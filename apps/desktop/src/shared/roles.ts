import type { OrgRole } from '@tent-nocode/core';

/** Single source for actions and their role gates; enforced in main/ipc/registry.ts. */
export type DeskAction =
  | 'approve_plan'
  | 'cancel'
  | 'submit'
  | 'config'
  | 'members';

/** owner or admin — anyone but a bare viewer (the operator tier died; multiplayer comes much later). */
const OWNER_ADMIN: ReadonlySet<OrgRole> = new Set(['owner', 'admin']);

// Role-action matrix: owner/admin act; a viewer is permitted nothing.
const ACTION_ROLES: Record<DeskAction, ReadonlySet<OrgRole>> = {
  approve_plan: OWNER_ADMIN,
  cancel: OWNER_ADMIN,
  submit: OWNER_ADMIN,
  config: OWNER_ADMIN,
  members: OWNER_ADMIN,
};

/** True if `role` is permitted to perform `action`. A viewer is permitted nothing. */
export function can(role: OrgRole, action: DeskAction): boolean {
  return ACTION_ROLES[action].has(role);
}

/** Maps escalation kinds to their corresponding trust tier before checking `can()`. */
export function approvalAction(kind: string): DeskAction {
  return kind === 'org_settings' ? 'config' : 'approve_plan';
}
