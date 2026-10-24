import type postgres from 'postgres';
import { orgConfigSchema, type OrgConfig } from '@nodeloom/core';
import { emitEvent } from './events.js';

// Reads orgs.config and fills defaults via the schema; unknown keys are ignored.
export async function getOrgConfig(sql: postgres.Sql, orgId: string): Promise<OrgConfig> {
  const rows = await sql<{ config: Record<string, unknown> }[]>`
    select config from orgs where id = ${orgId}`;
  return orgConfigSchema.parse(rows[0]?.config ?? {});
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const prev = out[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v)
      && prev !== null && typeof prev === 'object' && !Array.isArray(prev)
      ? deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out;
}

// The sanctioned org config setter; persisting freezes today's schema defaults into the row for untouched keys.
export async function setOrgConfig(
  sql: postgres.Sql, orgId: string, patch: Record<string, unknown>, opts?: { updatedBy?: string },
): Promise<OrgConfig> {
  const rows = await sql<{ config: Record<string, unknown> }[]>`select config from orgs where id = ${orgId}`;
  if (!rows[0]) throw new Error(`org not found: ${orgId}`);
  const merged = orgConfigSchema.parse(deepMerge(rows[0].config ?? {}, patch));
  await sql`update orgs set config = ${sql.json(merged as unknown as postgres.JSONValue)} where id = ${orgId}`;
  await emitEvent(sql, {
    orgId, actor: 'kernel.config', type: 'org.config_updated',
    payload: { patch, updatedBy: opts?.updatedBy ?? null },
  });
  return merged;
}
