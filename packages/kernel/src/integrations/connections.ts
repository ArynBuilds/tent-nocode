// The connections registry: org rows binding a project to a catalog entry; the token flows UI to vault directly, never through this module.
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { ensureDataset } from '../tabs/datasets.js';
import { integrationSpecHash, resolveIntegrationDef, type IntegrationDef } from './catalog.js';
import { ownerHostFailure } from './gate.js';

const ACTOR = 'kernel.integrations';

export interface IntegrationConnectionRow {
  id: string;
  org_id: string;
  project_id: string;
  integration: string;
  version: number;
  spec_hash: string;
  owner_host: string | null;
  scope: 'builder' | 'app-user';
  label: string;
  settings: Record<string, unknown>;
  status: 'unconnected' | 'active' | 'revoked';
  /** Map of declared inside-table names to real dataset names. */
  inside: { tables?: Record<string, string> };
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}

export interface ConnectIntegrationInput {
  orgId: string;
  projectId: string;
  name: string;
  version?: number;
  ownerHost?: string;
  /** The host template's single-label slot value. */
  hostValue?: string;
  label?: string;
  createdBy: string;
}

export type ConnectResult = { ok: true; connection: IntegrationConnectionRow } | { ok: false; refusal: string };

/** Places an integration node: the row is born 'unconnected' and the Connect card activates it later. */
export async function placeIntegrationNode(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; name: string; version?: number; label?: string; createdBy: string },
): Promise<ConnectResult> {
  const def = resolveIntegrationDef(input.name, input.version);
  if (!def) return { ok: false, refusal: `"${input.name}" is not in the integration catalog` };
  const label = input.label?.trim() || def.displayName;
  const [row] = await sql<IntegrationConnectionRow[]>`
    insert into integration_connections (org_id, project_id, integration, version, spec_hash, scope, label, status, created_by)
    values (${input.orgId}, ${input.projectId}, ${def.name}, ${def.version}, ${integrationSpecHash(def)},
            ${'builder'}, ${label}, ${'unconnected'}, ${input.createdBy})
    returning *`;
  if (!row) return { ok: false, refusal: 'the node could not be saved' };

  // Declared inside tables are created at placement, one per declaration per node; the first free name wins.
  const insideTables: Record<string, string> = {};
  for (const t of def.inside.tables) {
    let name = `${def.name}-${t.name}`;
    for (let i = 2; ; i++) {
      const [taken] = await sql<{ id: string }[]>`
        select id from datasets
        where org_id = ${input.orgId} and project_id = ${input.projectId} and name = ${name} and deleted_at is null`;
      if (!taken) break;
      name = `${def.name}-${t.name}-${i}`;
    }
    // The def's declared grain persists on the born table.
    await ensureDataset(sql, { orgId: input.orgId, projectId: input.projectId, name, rowSchema: t.rowSchema, userScope: t.grain });
    insideTables[t.name] = name;
  }
  if (Object.keys(insideTables).length > 0) {
    const inside = { tables: insideTables };
    await sql`update integration_connections set inside = ${sql.json(inside as postgres.JSONValue)} where id = ${row.id}`;
    row.inside = inside;
  }

  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'integration.placed',
    payload: { connectionId: row.id, integration: def.name, version: def.version, tables: Object.keys(insideTables) },
  });
  return { ok: true, connection: row };
}

/** Activates a placed connection: validates the owner-pinned host where declared and flips the status; the token rides secrets.set directly. */
export async function activateIntegrationConnection(
  sql: postgres.Sql,
  input: { orgId: string; id: string; ownerHost?: string; hostValue?: string; by: string },
): Promise<ConnectResult> {
  const existing = await getIntegrationConnection(sql, input.orgId, input.id);
  if (!existing || existing.revoked_at) return { ok: false, refusal: 'that connection is already gone' };
  const def = resolveIntegrationDef(existing.integration, existing.version);
  if (!def) return { ok: false, refusal: `"${existing.integration}" is not in the integration catalog` };
  // An upcoming entry places but does not connect yet.
  if (def.availability === 'upcoming') {
    return { ok: false, refusal: `${def.displayName} is upcoming - it connects the moment its approval clears` };
  }

  let ownerHost: string | null = existing.owner_host;
  if (Array.isArray(def.hosts)) {
    // A multi-host def lets the owner pick one of the declared hosts only.
    if (input.ownerHost) {
      if (!def.hosts.includes(input.ownerHost)) {
        return { ok: false, refusal: `${def.displayName} only reaches its own declared addresses` };
      }
      ownerHost = input.ownerHost;
    }
  } else if ('template' in def.hosts) {
    // Host template: one single-label slot filled here; the domain suffix stays def-declared.
    const label = input.hostValue?.trim().toLowerCase();
    if (!label && !ownerHost) return { ok: false, refusal: `${def.displayName} needs its account's address code` };
    if (label) {
      if (!/^[a-z0-9-]{1,30}$/.test(label)) return { ok: false, refusal: 'the address code is short letters and numbers alone' };
      const filled = def.hosts.template.replace(`{${def.hosts.slot}}`, label);
      const failure = ownerHostFailure(filled);
      if (failure) return { ok: false, refusal: failure };
      ownerHost = new URL(filled).origin;
    }
  } else {
    if (!input.ownerHost && !ownerHost) return { ok: false, refusal: `${def.displayName} needs the address of your own service to send to` };
    if (input.ownerHost) {
      const failure = ownerHostFailure(input.ownerHost);
      if (failure) return { ok: false, refusal: failure };
      ownerHost = new URL(input.ownerHost).origin;
    }
  }

  const [row] = await sql<IntegrationConnectionRow[]>`
    update integration_connections
    set status = 'active', owner_host = ${ownerHost}
    where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
    returning *`;
  if (!row) return { ok: false, refusal: 'that connection is already gone' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'integration.connected',
    payload: { connectionId: row.id, integration: def.name, version: def.version, endpoints: def.endpoints.length },
  });
  return { ok: true, connection: row };
}

/** One-step place plus activate. */
export async function connectIntegration(sql: postgres.Sql, input: ConnectIntegrationInput): Promise<ConnectResult> {
  const def = resolveIntegrationDef(input.name, input.version);
  if (!def) return { ok: false, refusal: `"${input.name}" is not in the integration catalog` };
  const placed = await placeIntegrationNode(sql, input);
  if (!placed.ok) return placed;
  const activated = await activateIntegrationConnection(sql, {
    orgId: input.orgId, id: placed.connection.id,
    ...(input.ownerHost !== undefined ? { ownerHost: input.ownerHost } : {}),
    ...(input.hostValue !== undefined ? { hostValue: input.hostValue } : {}),
    by: input.createdBy,
  });
  if (!activated.ok) {
    // All-or-nothing: a refused activation removes the just-placed row.
    await sql`delete from integration_connections where id = ${placed.connection.id}`;
    return activated;
  }
  return activated;
}

/** Live connections for an org (optionally one project). Revoked rows stay out. */
export async function listIntegrationConnections(
  sql: postgres.Sql,
  input: { orgId: string; projectId?: string },
): Promise<IntegrationConnectionRow[]> {
  if (input.projectId) {
    return sql<IntegrationConnectionRow[]>`
      select * from integration_connections
      where org_id = ${input.orgId} and project_id = ${input.projectId} and revoked_at is null
      order by created_at asc`;
  }
  return sql<IntegrationConnectionRow[]>`
    select * from integration_connections
    where org_id = ${input.orgId} and revoked_at is null
    order by created_at asc`;
}

export async function getIntegrationConnection(sql: postgres.Sql, orgId: string, id: string): Promise<IntegrationConnectionRow | null> {
  const [row] = await sql<IntegrationConnectionRow[]>`
    select * from integration_connections where org_id = ${orgId} and id = ${id}`;
  return row ?? null;
}

/** Tombstones the connection; its born inside tables tombstone with it. */
export async function revokeIntegrationConnection(
  sql: postgres.Sql,
  input: { orgId: string; id: string; by: string },
): Promise<{ ok: true } | { ok: false; refusal: string }> {
  const [row] = await sql<{ id: string; integration: string; project_id: string; inside: { tables?: Record<string, string> } }[]>`
    update integration_connections
    set status = 'revoked', revoked_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
    returning id, integration, project_id, inside`;
  if (!row) return { ok: false, refusal: 'that connection is already gone' };
  for (const datasetName of Object.values(row.inside?.tables ?? {})) {
    await sql`
      update datasets set deleted_at = now()
      where org_id = ${input.orgId} and project_id = ${row.project_id} and name = ${datasetName} and deleted_at is null`;
  }
  await emitEvent(sql, {
    orgId: input.orgId,
    actor: ACTOR,
    type: 'integration.revoked',
    payload: { connectionId: row.id, integration: row.integration, by: input.by },
  });
  return { ok: true };
}

/** Validates candidate settings against the def's declared settings rows; one plain sentence per refusal. */
export function settingsFailures(def: IntegrationDef, candidate: Record<string, unknown>): string[] {
  const failures: string[] = [];
  for (const [key, value] of Object.entries(candidate)) {
    const decl = def.settings.find((s) => s.id === key);
    if (!decl) {
      failures.push(`${def.displayName} has no setting "${key}"`);
      continue;
    }
    if (decl.kind === 'number' && typeof value !== 'number') failures.push(`"${decl.label}" wants a number`);
    else if (decl.kind === 'boolean' && typeof value !== 'boolean') failures.push(`"${decl.label}" is on or off`);
    else if ((decl.kind === 'text' || decl.kind === 'template' || decl.kind === 'channel-pick') && typeof value !== 'string') {
      failures.push(`"${decl.label}" wants text`);
    } else if (decl.kind === 'enum') {
      if (typeof value !== 'string' || !decl.choices?.includes(value)) {
        failures.push(`"${decl.label}" must be one of: ${(decl.choices ?? []).join(', ')}`);
      }
    }
  }
  return failures;
}

/** Updates the node's settings. */
export async function updateIntegrationSettings(
  sql: postgres.Sql,
  input: { orgId: string; id: string; settings: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; refusal: string }> {
  const existing = await getIntegrationConnection(sql, input.orgId, input.id);
  if (!existing || existing.revoked_at) return { ok: false, refusal: 'that connection is already gone' };
  const def = resolveIntegrationDef(existing.integration, existing.version);
  if (!def) return { ok: false, refusal: `"${existing.integration}" is not in the integration catalog` };
  const failures = settingsFailures(def, input.settings);
  if (failures.length > 0) return { ok: false, refusal: failures.join('; ') };
  await sql`
    update integration_connections
    set settings = settings || ${sql.json(input.settings as postgres.JSONValue)}
    where org_id = ${input.orgId} and id = ${input.id}`;
  await emitEvent(sql, {
    orgId: input.orgId,
    actor: ACTOR,
    type: 'integration.settings_updated',
    payload: { connectionId: input.id, integration: existing.integration, keys: Object.keys(input.settings) },
  });
  return { ok: true };
}
