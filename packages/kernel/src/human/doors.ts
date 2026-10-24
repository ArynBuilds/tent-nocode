import { readFile } from 'node:fs/promises';
import type postgres from 'postgres';
import { sceneBindingsSchema, type SceneBinding } from '@nodeloom/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { ensureDataset, validateRows } from '../tabs/datasets.js';
import { createScene, createSceneTab, requireScene } from '../scenes/store.js';
import { setSceneContracts } from '../scenes/actions.js';
import { createTrigger } from '../triggers.js';
import { createReactiveChain } from '../operations/reactive.js';
import { runOperation } from '../operations/dispatch.js';
import { createOperation, resolveOperation } from '../operations/registry.js';
import { importPackage } from '../scenes/packageImport.js';

// Human doors: thin kernel wrappers over the existing writes with actor 'user', no consent cards.

const ACTOR = 'user';

export type RowSchema = Record<string, 'string' | 'number' | 'boolean'>;

/** Creates a new empty dataset in the given project. */
export async function insertDataset(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; name: string; columns?: RowSchema; displayName?: string; by: string },
): Promise<{ datasetId: string }> {
  const res = await ensureDataset(sql, { orgId: input.orgId, projectId: input.projectId, name: input.name, rowSchema: input.columns ?? {} });
  if (input.displayName !== undefined && input.displayName.trim() !== '') {
    await sql`update datasets set display_name = ${input.displayName.trim().slice(0, 80)} where id = ${res.datasetId}`;
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.node_inserted',
    payload: { kind: 'dataset', name: input.name, projectId: input.projectId, by: input.by },
  });
  return res;
}

/** Creates a scene plus its tab row in the given project; no build is dispatched. */
export async function insertScene(
  sql: postgres.Sql,
  input: { orgId: string; title: string; by: string; targetScreen?: { w: number; h: number }; projectId?: string },
): Promise<{ sceneId: string; slug: string; tabId: string }> {
  const { sceneId, slug } = await createScene(sql, {
    orgId: input.orgId, title: input.title, createdBy: input.by,
    projectId: input.projectId ?? null,
  });
  const contracts = await setSceneContracts(sql, { orgId: input.orgId, sceneSlug: slug, bindings: [], actions: [] });
  if (!contracts.ok) throw new Error(`insertScene contracts: ${contracts.errors.join('; ')}`);
  const { tabId } = await createSceneTab(sql, {
    orgId: input.orgId, sceneId, sceneSlug: slug, title: input.title, createdBy: input.by,
    projectId: input.projectId ?? null,
  });
  if (input.targetScreen !== undefined) {
    await sql`update scenes set target_screen = ${sql.json(input.targetScreen)} where id = ${sceneId}`;
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.node_inserted',
    payload: { kind: 'scene', sceneId, slug, title: input.title, by: input.by, projectId: input.projectId ?? null },
  });
  return { sceneId, slug, tabId };
}

/** Gets or creates the project's canvas document: its one scene with no tab row, so it never publishes. */
export async function projectCanvas(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; by: string },
): Promise<{ sceneId: string; slug: string }> {
  const [standing] = await sql<{ id: string; slug: string }[]>`
    select s.id, s.slug from scenes s
    where s.org_id = ${input.orgId} and s.project_id = ${input.projectId}
      and s.status <> 'deleted'
      and not exists (select 1 from tabs t where t.scene_id = s.id)
    order by s.created_at asc limit 1`;
  if (standing !== undefined) return { sceneId: standing.id, slug: standing.slug };
  const { sceneId, slug } = await createScene(sql, {
    orgId: input.orgId, title: 'Canvas', createdBy: input.by, projectId: input.projectId,
  });
  const contracts = await setSceneContracts(sql, { orgId: input.orgId, sceneSlug: slug, bindings: [], actions: [] });
  if (!contracts.ok) throw new Error(`projectCanvas contracts: ${contracts.errors.join('; ')}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.node_inserted',
    payload: { kind: 'canvas', sceneId, slug, projectId: input.projectId, by: input.by },
  });
  return { sceneId, slug };
}

/** Reads the per-project canvas arrangement doc (positions and folds); one row per project. */
export async function getArrangement(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string },
): Promise<Record<string, unknown> | null> {
  const [row] = await sql<{ doc: Record<string, unknown> }[]>`
    select doc from workspace_arrangements
    where org_id = ${input.orgId} and project_id = ${input.projectId}`;
  return row?.doc ?? null;
}

export async function setArrangement(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; doc: Record<string, unknown> },
): Promise<void> {
  await sql`
    insert into workspace_arrangements (org_id, project_id, doc, updated_at)
    values (${input.orgId}, ${input.projectId}, ${sql.json(input.doc as never)}, now())
    on conflict (org_id, project_id)
    do update set doc = excluded.doc, updated_at = now()`;
}

/** Merges moved cards into the saved layout and, when given, replaces the groups; one locked read-modify-write. */
export async function mergeArrangement(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; positions: Record<string, { x: number; y: number }>; folds: unknown[] | null },
): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ doc: Record<string, unknown> }[]>`
      select doc from workspace_arrangements
      where org_id = ${input.orgId} and project_id = ${input.projectId} for update`;
    const doc = row?.doc ?? {};
    const saved = typeof doc['positions'] === 'object' && doc['positions'] !== null ? doc['positions'] as Record<string, unknown> : {};
    const next = { ...doc, positions: { ...saved, ...input.positions }, ...(input.folds !== null ? { folds: input.folds } : {}) };
    await setArrangement(tx as unknown as postgres.Sql, { orgId: input.orgId, projectId: input.projectId, doc: next });
  });
}

/** Creates a trigger; the trigger row itself is the standing grant. */
export async function mintTrigger(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; kind: string; spec: unknown; action: unknown; by: string },
): Promise<{ ok: true; triggerId: string } | { ok: false; reason: string }> {
  const res = await createTrigger(sql, {
    orgId: input.orgId, projectId: input.projectId, kind: input.kind, spec: input.spec, action: input.action, createdBy: input.by,
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.node_inserted',
      payload: { kind: 'trigger', triggerId: res.triggerId, by: input.by },
    });
  }
  return res;
}

/** Creates a reactive chain with its grant carried in-row. */
export async function mintChain(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; operation: string; inputs: Record<string, unknown>; by: string },
): Promise<{ ok: true; chainId: string; watch: string[] } | { ok: false; reason: string }> {
  return createReactiveChain(sql, {
    orgId: input.orgId, projectId: input.projectId, operation: input.operation, inputs: input.inputs,
    createdBy: input.by, grantMode: 'ask-approved',
  });
}

/** Sets one binding on a scene's contracts; a same-named binding replaces, others carry over. */
export async function setBinding(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; binding: unknown; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const one = sceneBindingsSchema.safeParse([input.binding]);
  if (!one.success) {
    return { ok: false, errors: one.error.issues.map((i) => `binding: ${i.path.join('.')} ${i.message}`) };
  }
  const parsed = one.data[0] as SceneBinding;
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const [row] = await sql<{ bindings: unknown; actions: unknown }[]>`
    select bindings, actions from scenes where id = ${scene.id}`;
  const existing = sceneBindingsSchema.parse(row?.bindings ?? []);
  const next = [...existing.filter((b) => b.name !== parsed.name), parsed];
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: next, actions: row?.actions ?? [],
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_set',
      payload: { sceneSlug: input.sceneSlug, binding: parsed.name, kind: parsed.kind, by: input.by },
    });
  }
  return res;
}

/** Removes the named binding from a scene's contracts; everything else carries over. */
export async function removeBinding(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; name: string; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const [row] = await sql<{ bindings: unknown; actions: unknown }[]>`
    select bindings, actions from scenes where id = ${scene.id}`;
  const existing = sceneBindingsSchema.parse(row?.bindings ?? []);
  const next = existing.filter((b) => b.name !== input.name);
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: next, actions: row?.actions ?? [],
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_removed',
      payload: { sceneSlug: input.sceneSlug, binding: input.name, by: input.by },
    });
  }
  return res;
}

/** Sets the scene's design size; null clears back to the kind default. */
export async function setTargetScreen(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; target: { w: number; h: number } | null; by: string },
): Promise<void> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  if (input.target !== null && (!Number.isFinite(input.target.w) || !Number.isFinite(input.target.h)
    || input.target.w < 200 || input.target.h < 200 || input.target.w > 10_000 || input.target.h > 10_000)) {
    throw new Error('the design size needs a width and height between 200 and 10000');
  }
  await sql`update scenes set target_screen = ${input.target === null ? null : sql.json(input.target)} where id = ${scene.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.design_size_set',
    payload: { sceneSlug: input.sceneSlug, target: input.target, by: input.by },
  });
}

// setAction and removeActionRule live in actionDoors.ts.

/** Dispatches a one-off operation run with human provenance. */
export async function dispatchOpRun(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; operation: string; version?: number; inputs: Record<string, unknown>; by: string },
): Promise<{ ok: true; executionId: string; operation: string; version: number } | { ok: false; reason: string }> {
  return runOperation(sql, {
    orgId: input.orgId, projectId: input.projectId, operation: input.operation,
    ...(input.version !== undefined ? { version: input.version } : {}),
    inputs: input.inputs, trigger: { kind: 'human' }, createdBy: input.by,
  });
}

/** Saves operation code as a new version; absent contract/runtime carry over from the head version. */
export async function registerOperationVersion(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; name: string; code: string; by: string; runtime?: 'wasm' | 'native'; ioContract?: unknown; displayName?: string },
): Promise<{ ok: true; name: string; version: number } | { ok: false; errors: string[] }> {
  const head = await resolveOperation(sql, input.orgId, { name: input.name }, input.projectId);
  const runtime = input.runtime ?? head?.runtime ?? 'wasm';
  const ioContract = input.ioContract ?? head?.ioContract;
  if (ioContract === undefined) return { ok: false, errors: [`no operation named '${input.name}' — a fresh Tool declares its contract`] };
  const res = await createOperation(sql, {
    orgId: input.orgId, projectId: input.projectId, name: input.name, code: input.code, runtime,
    ioContract, provenanceRunId: null, createdBy: input.by,
  });
  if (!res.ok) return res;
  if (input.displayName !== undefined && input.displayName.trim() !== '') {
    await sql`update operations set display_name = ${input.displayName.trim().slice(0, 80)}
      where org_id = ${input.orgId} and name = ${input.name}`;
  }
  return { ok: true, name: res.name, version: res.version };
}

/** Points an operation's rows output at a table plus key column by re-minting the contract as version+1; clear unbinds. */
export async function bindOpOutput(
  sql: postgres.Sql,
  input: {
    orgId: string; projectId: string | null; operation: string; output?: string;
    dataset?: string; key?: string; clear?: boolean; by: string;
  },
): Promise<{ ok: true; operation: string; version: number; output: string } | { ok: false; reason: string }> {
  const head = await resolveOperation(sql, input.orgId, { name: input.operation }, input.projectId);
  if (!head) return { ok: false, reason: `no active operation named '${input.operation}'` };
  const rowsOutputs = Object.entries(head.ioContract.outputs)
    .filter(([, o]) => o.kind === 'dataset' && o.datasetFrom === undefined);
  if (rowsOutputs.length === 0) {
    return { ok: false, reason: `'${input.operation}' produces no table rows — its outputs are arrays or images` };
  }
  const outputName = input.output ?? (rowsOutputs.length === 1 ? rowsOutputs[0]![0] : undefined);
  if (outputName === undefined) {
    return { ok: false, reason: `'${input.operation}' has several rows outputs — name the one to connect (${rowsOutputs.map(([n]) => n).join(', ')})` };
  }
  const decl = head.ioContract.outputs[outputName];
  if (decl === undefined || decl.kind !== 'dataset' || decl.datasetFrom !== undefined) {
    return { ok: false, reason: `'${outputName}' is not a connectable rows output of '${input.operation}'` };
  }
  const clear = input.clear === true;
  if (!clear) {
    if (input.dataset === undefined || input.key === undefined) {
      return { ok: false, reason: 'a write-back names its table AND its key column' };
    }
    const [target] = await sql<{ row_schema: Record<string, string> }[]>`
      select row_schema from datasets
      where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null`;
    if (!target) return { ok: false, reason: `no table named '${input.dataset}' in this project` };
    if (!(input.key in target.row_schema)) {
      return { ok: false, reason: `key column '${input.key}' is not one of '${input.dataset}'s declared columns` };
    }
  }
  const { dataset: _d, key: _k, ...bare } = decl;
  const nextContract = {
    inputs: head.ioContract.inputs,
    outputs: {
      ...head.ioContract.outputs,
      [outputName]: clear ? bare : { ...bare, dataset: input.dataset!, key: input.key! },
    },
  };
  const res = await createOperation(sql, {
    orgId: input.orgId, projectId: input.projectId, name: head.name, code: head.code,
    runtime: head.runtime, ioContract: nextContract, provenanceRunId: null, createdBy: input.by,
    modelHash: head.modelHash, modelPath: head.modelPath, modelLicense: head.modelLicense,
  });
  if (!res.ok) return { ok: false, reason: res.errors.join('; ') };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: clear ? 'human.wire_removed' : 'human.wire_set',
    payload: {
      operation: head.name, output: outputName, by: input.by,
      ...(clear ? {} : { dataset: input.dataset, key: input.key }),
    },
  });
  return { ok: true, operation: res.name, version: res.version, output: outputName };
}

/** Opens a dropped package through the silent import gauntlet; speaks one plain sentence only on failure. */
export async function importPackageAsUser(
  sql: postgres.Sql,
  input: { orgId: string; filePath: string; by: string; projectId?: string },
): Promise<{ ok: true; alreadyImported?: boolean; projectName?: string } | { ok: false; sentence: string }> {
  let file: unknown;
  try {
    file = JSON.parse(await readFile(input.filePath, 'utf8'));
  } catch {
    return { ok: false, sentence: 'this file could not be read as a package' };
  }
  // A drop with no project home finds or births a project by the app's title.
  const res = await importPackage(sql, {
    orgId: input.orgId, file, createdBy: input.by,
    ...(input.projectId !== undefined
      ? { projectId: input.projectId }
      : { findOrBirthProject: true, sourcePath: input.filePath }),
  });
  if (!res.ok) {
    const first = (res.errors ?? [])[0] ?? 'one entry does not match its hash';
    return { ok: false, sentence: `this file is damaged — ${first}` };
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.package_opened',
    payload: { path: input.filePath, by: input.by, alreadyImported: res.alreadyImported === true },
  });
  return {
    ok: true,
    ...(res.alreadyImported === true ? { alreadyImported: true } : {}),
    ...(res.projectName !== undefined ? { projectName: res.projectName } : {}),
  };
}

// ---- Grid row writes: same validation walls, actor user, evented ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireDataset(
  sql: postgres.Sql, orgId: string, projectId: string | null, dataset: string,
): Promise<{ id: string; row_schema: RowSchema; column_display: Record<string, string> | null }> {
  const [d] = await sql<{ id: string; row_schema: RowSchema; column_display: Record<string, string> | null }[]>`
    select id, row_schema, column_display from datasets
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and name = ${dataset} and deleted_at is null`;
  if (!d) throw new Error(`no dataset named '${dataset}'`);
  return d;
}

/** Inline cell edit; the merged row re-passes the same validation as an append. */
export async function updateRowById(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; rowId: string; patch: Record<string, unknown>; by: string },
): Promise<{ applied: true } | { applied: false; reason: string }> {
  if (!UUID_RE.test(input.rowId)) return { applied: false, reason: 'rows are addressed by their kernel row id' };
  const d = await requireDataset(sql, input.orgId, input.projectId, input.dataset);
  const [target] = await sql<{ id: string; row: Record<string, unknown> }[]>`
    select id, row from dataset_rows where id = ${input.rowId} and dataset_id = ${d.id}`;
  if (!target) return { applied: false, reason: `no row with that id in '${input.dataset}'` };
  const merged = { ...target.row, ...input.patch };
  const verdict = validateRows([merged], d.row_schema);
  if (verdict.accepted.length === 0) {
    return { applied: false, reason: verdict.rejected[0]?.reason ?? 'the change violates the row shape' };
  }
  await sql`update dataset_rows set row = ${sql.json(verdict.accepted[0] as postgres.JSONValue)} where id = ${target.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.row_updated',
    payload: { dataset: input.dataset, rowId: target.id, set: Object.keys(input.patch), by: input.by },
  });
  return { applied: true };
}

export async function appendRowHuman(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; row: Record<string, unknown>; by: string },
): Promise<{ applied: true; rowId: string } | { applied: false; reason: string }> {
  const d = await requireDataset(sql, input.orgId, input.projectId, input.dataset);
  const verdict = validateRows([input.row], d.row_schema);
  if (verdict.accepted.length === 0) {
    return { applied: false, reason: verdict.rejected[0]?.reason ?? 'the row violates the declared shape' };
  }
  const [row] = await sql<{ id: string }[]>`
    insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
    values (${input.orgId}, ${d.id}, ${sql.json(verdict.accepted[0] as postgres.JSONValue)}, ${null})
    returning id`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.row_appended',
    payload: { dataset: input.dataset, rowId: row!.id, by: input.by },
  });
  return { applied: true, rowId: row!.id };
}

export async function deleteRowById(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; rowId: string; by: string },
): Promise<{ applied: true; row: Record<string, unknown> } | { applied: false; reason: string }> {
  if (!UUID_RE.test(input.rowId)) return { applied: false, reason: 'rows are addressed by their kernel row id' };
  const d = await requireDataset(sql, input.orgId, input.projectId, input.dataset);
  const [target] = await sql<{ id: string; row: Record<string, unknown> }[]>`
    select id, row from dataset_rows where id = ${input.rowId} and dataset_id = ${d.id}`;
  if (!target) return { applied: false, reason: `no row with that id in '${input.dataset}'` };
  await sql`delete from dataset_rows where id = ${target.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.row_deleted',
    payload: { dataset: input.dataset, rowId: target.id, by: input.by },
  });
  return { applied: true, row: target.row };
}

/** Re-inserts a deleted row with its original id so wires addressed by id keep working. */
export async function restoreRowById(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; rowId: string; row: Record<string, unknown>; by: string },
): Promise<{ applied: true } | { applied: false; reason: string }> {
  if (!UUID_RE.test(input.rowId)) return { applied: false, reason: 'rows are addressed by their kernel row id' };
  const d = await requireDataset(sql, input.orgId, input.projectId, input.dataset);
  const verdict = validateRows([input.row], d.row_schema);
  if (verdict.accepted.length === 0) {
    return { applied: false, reason: verdict.rejected[0]?.reason ?? 'the row violates the declared shape' };
  }
  const [exists] = await sql<{ id: string }[]>`select id from dataset_rows where id = ${input.rowId}`;
  if (exists) return { applied: false, reason: 'a row with that id already exists' };
  await sql`
    insert into dataset_rows (id, org_id, dataset_id, row, evidence_run_id)
    values (${input.rowId}, ${input.orgId}, ${d.id}, ${sql.json(verdict.accepted[0] as postgres.JSONValue)}, ${null})`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.row_restored',
    payload: { dataset: input.dataset, rowId: input.rowId, by: input.by },
  });
  return { applied: true };
}

/** Sets a per-column display override; the key never renames, and empty clears it. */
export async function setColumnDisplay(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; column: string; display: string | null; by: string },
): Promise<void> {
  const d = await requireDataset(sql, input.orgId, input.projectId, input.dataset);
  if (!(input.column in d.row_schema)) throw new Error(`no column '${input.column}' in '${input.dataset}'`);
  const next = { ...(d.column_display ?? {}) };
  if (input.display === null || input.display.trim() === '') delete next[input.column];
  else next[input.column] = input.display.trim();
  await sql`update datasets set column_display = ${sql.json(next)} where id = ${d.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.column_display_set',
    payload: { dataset: input.dataset, column: input.column, display: input.display, by: input.by },
  });
}
