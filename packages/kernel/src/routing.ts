import type { JobKind, OrgConfig } from '@tent-nocode/core';

/** Resolve the model pin for a lane: chat prefers deskModel; null means the CLI default. */
export function resolveModel(cfg: OrgConfig, lane: JobKind = 'work'): string | null {
  if (lane === 'chat') return cfg.deskModel ?? cfg.model;
  return cfg.model;
}
