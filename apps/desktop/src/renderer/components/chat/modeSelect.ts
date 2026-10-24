import type { ThreadMode } from '@nodeloom/core';

/** Labels a thread's mode; null means inherit the org default and says so. */
export function modeLabel(threadMode: ThreadMode | null, orgDefault: ThreadMode): string {
  return threadMode ?? `default (${orgDefault})`;
}
