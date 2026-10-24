import type { ThreadMode } from '@nodeloom/core';
import type { OrgConfigPatch } from '../../../shared/ipc.js';

// Translate control values to org config patches; undefined means don't send.

export type NumberField = 'autoBudgetUsdPerJob';
export type ConfigField = NumberField | 'defaultMode';

export function fieldPatch(field: ConfigField, raw: string): OrgConfigPatch | undefined {
  switch (field) {
    case 'autoBudgetUsdPerJob': {
      // Trimmed-empty means "no cap" (`null`) — a deliberate, valid state, not a bad edit.
      const trimmed = raw.trim();
      if (trimmed === '') return { chat: { autoBudgetUsdPerJob: null } };
      const n = Number(trimmed);
      return Number.isFinite(n) ? { chat: { autoBudgetUsdPerJob: n } } : undefined;
    }
    case 'defaultMode':
      return { chat: { defaultMode: raw as ThreadMode } };
  }
}
