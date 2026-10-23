import type postgres from 'postgres';
import {
  evalCondition, resolvePillValue, type FlowCondition, type FlowDoc, type FlowEnvelope,
  type FlowItem, type PillContext,
} from '@tent-nocode/core';
import { resolveFlowStepDef, type FlowStepDef } from './registry.js';
import { runIntegrationCall } from '../integrations/dispatch.js';
import { runOperation } from '../operations/dispatch.js';
import { peekDataset, recordDatasetAppend } from '../tabs/datasets.js';
import { persistFlowEnvelope, settleFlowExecution, startFlowExecution, type FlowExecutionRow } from './store.js';

// Flow engine: one tick runs one claimed execution as far as it can, persisting the envelope after every step.

export interface FlowEngineDeps {
  createdBy?: string;
}

// Entry steps have no incoming edges; each is fed one item carrying the trigger payload.
export function entrySteps(doc: FlowDoc): string[] {
  const targets = new Set(doc.edges.map((e) => e.to));
  return Object.keys(doc.steps).filter((id) => !targets.has(id));
}

// Route a step's outputs along edges; multi-required targets park until all required slots fill, and only ports present in outputs route.
export function routeOutputs(
  doc: FlowDoc, env: FlowEnvelope, step: string, outputs: Record<string, FlowItem[]>,
): void {
  env.results[step] = outputs;
  const edges = doc.edges
    .filter((e) => e.from === step && outputs[e.port] !== undefined)
    .sort((a, b) => a.order - b.order);
  for (const edge of edges) {
    const items = outputs[edge.port] ?? [];
    const targetDef = resolveFlowStepDef(doc.steps[edge.to]?.kind ?? '');
    const required = targetDef?.inputs.required ?? ['in'];
    if (required.length <= 1) {
      env.stack.push({ step: edge.to, inputs: { [edge.slot]: items } });
      continue;
    }
    const slots = env.waiting[edge.to] ?? {};
    slots[edge.slot] = items;
    env.waiting[edge.to] = slots;
    if (required.every((r) => r in slots)) {
      env.stack.push({ step: edge.to, inputs: slots });
      delete env.waiting[edge.to];
    }
  }
}

const nowIso = (): string => new Date().toISOString();

// Build the pill-resolution context for one item.
function pillCtx(
  sql: postgres.Sql, row: FlowExecutionRow, env: FlowEnvelope, item: FlowItem | null,
  tableCells: Map<string, unknown>,
): PillContext {
  return {
    item,
    results: env.results,
    trigger: env.trigger,
    inputs: env.inputs,
    nowIso: nowIso(),
    tableCell: (table, column) => tableCells.get(`${table}::${column}`),
  };
}

// Pre-read every table pill the doc references so pill resolution stays pure.
async function readTableCells(sql: postgres.Sql, row: FlowExecutionRow): Promise<Map<string, unknown>> {
  const cells = new Map<string, unknown>();
  const wanted = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['from'] === 'table' && typeof o['table'] === 'string' && typeof o['column'] === 'string') {
      wanted.add(`${o['table']}::${o['column']}`);
    }
    Object.values(o).forEach(walk);
  };
  walk(row.doc);
  for (const key of wanted) {
    const [table, column] = key.split('::') as [string, string];
    try {
      const peek = await peekDataset(sql, { orgId: row.org_id, projectId: row.project_id, name: table, limit: 1 });
      cells.set(key, peek.sampleRows[0]?.[column]);
    } catch { cells.set(key, undefined); }
  }
  return cells;
}

// The wait step's target moment from its params.
function waitTillOf(params: Record<string, unknown>): string {
  const until = params['until'];
  if (typeof until === 'string' && until !== '') return until;
  const minutes = typeof params['minutes'] === 'number' && params['minutes'] > 0 ? params['minutes'] : 1;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// Run one claimed execution until it settles or parks.
export async function tickFlowExecution(sql: postgres.Sql, row: FlowExecutionRow, deps: FlowEngineDeps = {}): Promise<void> {
  const env = row.envelope;
  const doc = row.doc;
  let stepsRun = row.steps_run;
  const tableCells = await readTableCells(sql, row);

  // A ripened wait re-enters its parked step as pass-through; a 'flow' park re-arms only via the child's settle.
  if (env.parked !== undefined && env.parked.reason === 'wait') {
    routeOutputs(doc, env, env.parked.step, { out: env.parked.inputs['in'] ?? [] });
    env.ran.push(env.parked.step);
    delete env.parked;
  }

  // A fresh run seeds its entry steps with the trigger item.
  if (env.stack.length === 0 && env.ran.length === 0 && Object.keys(env.results).length === 0) {
    for (const id of entrySteps(doc)) {
      env.stack.push({ step: id, inputs: { in: [{ json: env.trigger }] } });
    }
  }

  while (env.stack.length > 0) {
    // Guards: step budget and wall-clock deadline.
    if (stepsRun >= row.step_budget) {
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: `the run passed its ${row.step_budget}-step budget — a loop somewhere` });
      return;
    }
    if (new Date() > new Date(row.deadline)) {
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: 'the run passed its deadline' });
      return;
    }
    const entry = env.stack.pop()!;
    const step = doc.steps[entry.step];
    const def = step !== undefined ? resolveFlowStepDef(step.kind) : null;
    if (step === undefined || def === null) {
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: `no step kind '${step?.kind ?? entry.step}' — re-save the flow` });
      return;
    }
    stepsRun += 1;
    env.ran.push(entry.step);

    // Disabled steps pass items through untouched.
    if (step.disabled) {
      routeOutputs(doc, env, entry.step, { out: entry.inputs['in'] ?? [] });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    // A manual run substitutes pinned items for the real execution.
    if (step.pinned !== undefined && env.trigger['kind'] === 'manual') {
      routeOutputs(doc, env, entry.step, { out: step.pinned });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if ('pure' in def.exec) {
      const out = def.exec.pure({
        params: step.params,
        inputs: entry.inputs,
        resolve: (v, item) => resolvePillValue(v, pillCtx(sql, row, env, item, tableCells)),
        evalCondition: (cond: FlowCondition, item) => evalCondition(cond, pillCtx(sql, row, env, item, tableCells)),
      });
      if (out.error !== undefined) {
        await persistFlowEnvelope(sql, row.id, env, stepsRun);
        await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: out.error });
        return;
      }
      routeOutputs(doc, env, entry.step, out.outputs);
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    // Engine arms: the effectful step kinds.
    const arm = def.exec.engine;
    const items = entry.inputs['in'] ?? [];
    const resolveFor = (v: unknown, item: FlowItem | null): unknown => resolvePillValue(v, pillCtx(sql, row, env, item, tableCells));

    if (arm === 'batches') {
      // Loop context lives in the envelope; a wired-back entry collects and sends the next batch or fires done once.
      const loops = (env.loops ??= {});
      const sizeRaw = resolveFor(step.params['size'], null);
      const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw >= 1 ? Math.floor(sizeRaw) : 1;
      const ctx = loops[entry.step];
      if (ctx === undefined) {
        if (items.length === 0) {
          routeOutputs(doc, env, entry.step, { done: [] });
        } else {
          loops[entry.step] = { remaining: items.slice(size), collected: [] };
          routeOutputs(doc, env, entry.step, { loop: items.slice(0, size) });
        }
      } else if (ctx.remaining.length === 0) {
        ctx.collected.push(...items);
        const done = ctx.collected;
        delete loops[entry.step];
        routeOutputs(doc, env, entry.step, { done });
      } else {
        ctx.collected.push(...items);
        const batch = ctx.remaining.slice(0, size);
        ctx.remaining = ctx.remaining.slice(size);
        routeOutputs(doc, env, entry.step, { loop: batch });
      }
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if (arm === 'wait') {
      env.parked = { step: entry.step, reason: 'wait', inputs: entry.inputs };
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'waiting', waitTill: waitTillOf(step.params) });
      return;
    }

    if (arm === 'run-flow') {
      const name = String(resolveFor(step.params['flow'], null) ?? '');
      const [child] = await sql<{ id: string }[]>`
        select id from flows where org_id = ${row.org_id} and project_id = ${row.project_id} and name = ${name} and deleted_at is null`;
      if (!child) {
        await persistFlowEnvelope(sql, row.id, env, stepsRun);
        await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: `no flow named '${name}' here` });
        return;
      }
      const started = await startFlowExecution(sql, {
        orgId: row.org_id, flowId: child.id,
        trigger: { items: items.map((i) => i.json) }, parentExecutionId: row.id,
      });
      if (!started.ok) {
        await persistFlowEnvelope(sql, row.id, env, stepsRun);
        await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: started.refusal });
        return;
      }
      env.parked = { step: entry.step, reason: 'flow', inputs: entry.inputs, child: started.executionId };
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      // Parks indefinitely; the child's settle re-arms the parent.
      await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'waiting', waitTill: null });
      return;
    }

    if (arm === 'call-integration') {
      // Per item, resolve pills and queue the call through the one dispatch door.
      const connectionId = String(step.params['connection'] ?? '');
      const endpoint = String(step.params['endpoint'] ?? '');
      const rawParams = (typeof step.params['fields'] === 'object' && step.params['fields'] !== null ? step.params['fields'] : {}) as Record<string, unknown>;
      const out: FlowItem[] = [];
      for (const item of items.length > 0 ? items : [{ json: {} }]) {
        const resolved: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(rawParams)) {
          const r = resolveFor(v, item);
          if (r !== undefined && r !== null && (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean')) resolved[k] = r;
        }
        const res = await runIntegrationCall(sql, {
          orgId: row.org_id, connectionId, endpoint, params: resolved,
          trigger: { kind: 'trigger', triggerId: row.id }, createdBy: deps.createdBy ?? 'flow',
        });
        out.push({ json: res.ok ? { queued: true, executionId: res.executionId } : { queued: false, refusal: res.refusal } });
      }
      routeOutputs(doc, env, entry.step, { out });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if (arm === 'run-tool') {
      // Sealed lane: code touches data alone; reach and code compose as recorded steps.
      const operation = String(resolveFor(step.params['tool'], null) ?? '');
      const rawInputs = (typeof step.params['inputs'] === 'object' && step.params['inputs'] !== null ? step.params['inputs'] : {}) as Record<string, unknown>;
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawInputs)) resolved[k] = resolveFor(v, items[0] ?? null);
      // Arriving items fill the tool's first unset dataset slot.
      if (items.length > 0) {
        const { resolveOperation } = await import('../operations/registry.js');
        const op = await resolveOperation(sql, row.org_id, { name: operation }, row.project_id);
        const slot = op != null
          ? Object.entries(op.ioContract.inputs).find(([k, d]) => d.type === 'dataset' && resolved[k] === undefined)?.[0]
          : undefined;
        if (slot !== undefined) resolved[slot] = { __rows: items.map((i) => i.json) };
      }
      const res = await runOperation(sql, {
        orgId: row.org_id, projectId: row.project_id, operation, inputs: resolved,
        trigger: { kind: 'trigger', triggerId: row.id }, createdBy: deps.createdBy ?? 'flow',
      });
      routeOutputs(doc, env, entry.step, {
        out: [{ json: res.ok ? { queued: true, executionId: res.executionId } : { queued: false, refusal: res.reason } }],
      });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if (arm === 'get-rows') {
      // Read half: peek the latest rows, capped.
      const table = String(resolveFor(step.params['table'], null) ?? '');
      const limit = typeof step.params['limit'] === 'number' ? step.params['limit'] : 5000;
      let rows: Array<Record<string, unknown>> = [];
      try {
        const peek = await peekDataset(sql, { orgId: row.org_id, projectId: row.project_id, name: table, limit });
        rows = peek.sampleRows;
      } catch { rows = []; }
      routeOutputs(doc, env, entry.step, { out: rows.map((r) => ({ json: r })) });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if (arm === 'save-rows') {
      // Write half: items land through the standing data door.
      const table = String(resolveFor(step.params['table'], null) ?? '');
      const saved = await recordDatasetAppend(sql, {
        orgId: row.org_id, projectId: row.project_id, runId: null,
        append: { dataset: table, rows: items.map((i) => i.json) },
      }).catch((e: unknown) => ({ accepted: 0, rejected: [{ index: 0, reason: e instanceof Error ? e.message : 'the rows would not land' }] }));
      // A refused write fails the run loudly - a silent zero-save is data loss.
      if (saved.accepted === 0 && saved.rejected.length > 0 && items.length > 0) {
        await persistFlowEnvelope(sql, row.id, env, stepsRun);
        await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'failed', error: `Save rows refused: ${saved.rejected[0]!.reason}` });
        return;
      }
      routeOutputs(doc, env, entry.step, {
        out: [{ json: { saved: saved.accepted, table, ...(saved.rejected.length > 0 ? { refusal: saved.rejected[0]!.reason } : {}) } }],
      });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if (arm === 'screen-effect') {
      // Records the effect on the run; the page-side handler executes it after settle. Values are text, never markup.
      const first = items[0] ?? null;
      const effectKind = String(step.params['effect'] ?? '');
      const target = String(resolveFor(step.params['target'], first) ?? '');
      const value = resolveFor(step.params['value'], first);
      const text = value === undefined || value === null ? '' : String(value);
      const effects = (env.effects ??= []);
      // Empty required addresses record nothing; past the 40-effect cap the surplus drops.
      if (effects.length >= 40) { /* surplus drops */ }
      else if (effectKind === 'go-to' && target !== '') effects.push({ kind: 'goto', scene: target.slice(0, 80) });
      else if (effectKind === 'message') effects.push({ kind: 'message', text: text.slice(0, 500) });
      else if (effectKind === 'overlay-open' && target !== '') effects.push({ kind: 'overlay', node: target.slice(0, 80), open: true });
      else if (effectKind === 'overlay-close' && target !== '') effects.push({ kind: 'overlay', node: target.slice(0, 80), open: false });
      else if (effectKind === 'answer' && target !== '') effects.push({ kind: 'answer', key: target.slice(0, 80), value: text });
      routeOutputs(doc, env, entry.step, { out: items });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }

    if (arm === 'answer-caller') {
      // Records the flow's HTTP answer for the webhook caller once, first wins; the value lands as text.
      if (env.callerAnswer === undefined) {
        const first = items[0] ?? null;
        const value = resolveFor(step.params['value'], first);
        env.callerAnswer = {
          answer: value === undefined || value === null ? '' : String(value).slice(0, 4000),
          status: step.params['status'] === '201' || step.params['status'] === 201 ? 201 : 200,
          at: nowIso(),
        };
      }
      routeOutputs(doc, env, entry.step, { out: items });
      await persistFlowEnvelope(sql, row.id, env, stepsRun);
      continue;
    }
  }

  // Stack drained: a join that never got every input simply does not fire.
  await persistFlowEnvelope(sql, row.id, env, stepsRun);
  await settleFlowExecution(sql, { executionId: row.id, orgId: row.org_id, status: 'succeeded' });

  // A settled child re-arms its parked parent.
  if (row.parent_execution_id !== null) {
    await resumeParent(sql, row, env);
  }
}

// The child's last results become the parent step's outputs; the parent re-queues pending.
async function resumeParent(sql: postgres.Sql, child: FlowExecutionRow, childEnv: FlowEnvelope): Promise<void> {
  const [parent] = await sql<FlowExecutionRow[]>`
    select * from flow_executions where id = ${child.parent_execution_id} and status = 'waiting' for update`;
  if (parent === undefined) return;
  const penv = parent.envelope as FlowEnvelope;
  if (penv.parked === undefined || penv.parked.reason !== 'flow' || penv.parked.child !== child.id) return;
  const lastStep = childEnv.ran[childEnv.ran.length - 1];
  const lastOut = lastStep !== undefined ? childEnv.results[lastStep]?.['out'] ?? [] : [];
  routeOutputs(parent.doc, penv, penv.parked.step, { out: lastOut });
  penv.ran.push(penv.parked.step);
  delete penv.parked;
  await sql`update flow_executions
    set envelope = ${sql.json(penv as unknown as postgres.JSONValue)}, status = 'pending', wait_till = null
    where id = ${parent.id}`;
}

// Claim and tick executions until the queue drains.
export async function sweepFlowExecutions(
  sql: postgres.Sql, deps: FlowEngineDeps = {}, max = 20,
): Promise<number> {
  const { claimNextFlowExecution } = await import('./store.js');
  let n = 0;
  for (; n < max; n++) {
    const row = await claimNextFlowExecution(sql);
    if (row === null) break;
    try {
      await tickFlowExecution(sql, row, deps);
    } catch (e) {
      await settleFlowExecution(sql, {
        executionId: row.id, orgId: row.org_id, status: 'failed',
        error: e instanceof Error ? e.message.slice(0, 300) : 'the run failed',
      });
    }
  }
  return n;
}
