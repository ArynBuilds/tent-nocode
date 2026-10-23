import type postgres from 'postgres';
import { projectArm } from './containment.js';
import type { AutomationEdge, AutomationNode } from './observatory.js';

// Projects every flow doc's steps as graph nodes and its edges as flow wires.

interface StepConnection { id: string; integration: string; settings?: Record<string, unknown> | null }
interface StepTrigger { id: string; action: Record<string, unknown>; project_id: string | null }

// A param value's short word: pills speak as arrows, scalars as themselves.
export const paramWord = (v: unknown): string => {
  if (typeof v === 'object' && v !== null) {
    const p = v as { from?: string; param?: string; column?: string; field?: string };
    if (typeof p.from === 'string') return `← ${p.param ?? p.column ?? p.field ?? p.from}`;
    return '…';
  }
  return String(v).slice(0, 28);
};

export async function projectFlowSteps(sql: postgres.Sql, input: {
  orgId: string;
  projectId: string | null;
  addNode: (n: AutomationNode) => void;
  addEdge: (from: string, to: string, verb: AutomationEdge['verb'], meta?: { port?: string; slot?: string; via?: string }) => void;
  connections: StepConnection[];
  triggers: StepTrigger[];
}): Promise<void> {
  const { orgId, projectId, addNode, addEdge, connections, triggers } = input;
  const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
  const flowRows = await sql<{ id: string; name: string; project_id: string; doc: { steps?: Record<string, { kind?: string; disabled?: boolean; params?: Record<string, unknown> }>; edges?: Array<{ from: string; port: string; to: string; slot: string }> }; updated_at: Date }[]>`
    select id, name, project_id, doc, updated_at from flows
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and deleted_at is null`;
  const { resolveFlowStepDef } = await import('./flows/registry.js');
  const { resolveIntegrationDef } = await import('./integrations/catalog.js');

  // A configured call-integration step wears the door's own word with the service as subtitle.
  const doorFace = (params: Record<string, unknown> | undefined): { label: string; service: string; slug: string; connection: string; sockets: string[] } | null => {
    const connId = typeof params?.['connection'] === 'string' ? params['connection'] : '';
    const endpoint = typeof params?.['endpoint'] === 'string' ? params['endpoint'] : '';
    if (connId === '' || endpoint === '') return null;
    const conn = connections.find((c) => c.id === connId);
    if (conn === undefined) return null;
    const def = resolveIntegrationDef(conn.integration);
    const door = def?.endpoints.find((e) => e.id === endpoint);
    if (def === null || door === undefined) return null;
    const keyed = Object.keys(door.params).find((k) => {
      const v = params?.[k];
      return (typeof v === 'string' && v !== '') || typeof v === 'number';
    });
    const keyVal = keyed !== undefined ? String(params?.[keyed]).slice(0, 24) : null;
    // Sockets: required door fields with no param and no settings-fill. Cap 3.
    const fed = new Set([
      ...Object.keys(params ?? {}),
      ...Object.keys(conn.settings ?? {}).flatMap((k) => [k, k.replace(/^default_/, '')]),
    ]);
    const sockets = Object.entries(door.params)
      .filter(([k, p]) => (p as { required?: boolean }).required === true && !fed.has(k))
      .map(([k]) => k)
      .slice(0, 3);
    return {
      label: door.displayName,
      service: keyVal !== null ? `${def.displayName} · ${keyVal}` : def.displayName,
      slug: conn.integration,
      connection: connId,
      sockets,
    };
  };

  for (const f of flowRows) {
    // A fused run-tool step hides; its edges re-aim at the Tool card carrying `via`.
    const alias = new Map<string, string>();
    for (const [stepId, step] of Object.entries(f.doc.steps ?? {})) {
      if (step.kind === 'run-tool' && step.params?.['fused'] === true && typeof step.params['tool'] === 'string') {
        alias.set(stepId, `op:${step.params['tool']}`);
      }
    }
    for (const [stepId, step] of Object.entries(f.doc.steps ?? {})) {
      if (alias.has(stepId)) continue;
      const def = step.kind !== undefined ? resolveFlowStepDef(step.kind) : null;
      const face = step.kind === 'call-integration' ? doorFace(step.params) : null;
      // Grow rows: the step's own configured params; the connection/endpoint pair never.
      const grow = Object.entries(step.params ?? {})
        .filter(([k]) => k !== 'connection' && k !== 'endpoint')
        .slice(0, 3)
        .map(([k, v]) => ({ k, v: paramWord(v) }));
      addNode({
        id: `fstep:${f.id}:${stepId}`, kind: 'step',
        label: face?.label ?? def?.displayName ?? stepId,
        detail: step.disabled === true ? 'switched off' : face?.service ?? def?.blurb ?? null,
        lastActivityAt: iso(f.updated_at), projectId: f.project_id,
        ...(face !== null ? { service: face.slug } : {}),
        ...(face !== null && face.sockets.length > 0 ? { sockets: face.sockets } : {}),
        ...(grow.length > 0 ? { grow } : {}),
      });
      if (face !== null) addEdge(`fstep:${f.id}:${stepId}`, `intg:${face.connection}`, 'runs');
      // Table-param bridges draw as real declaration-derived edges.
      if (typeof step.params?.['table'] === 'string' && step.params['table'] !== '') {
        if (step.kind === 'get-rows') addEdge(`ds:${step.params['table']}`, `fstep:${f.id}:${stepId}`, 'feeds');
        if (step.kind === 'save-rows') addEdge(`fstep:${f.id}:${stepId}`, `ds:${step.params['table']}`, 'updates');
      }
    }
    for (const e of f.doc.edges ?? []) {
      const from = alias.get(e.from) ?? `fstep:${f.id}:${e.from}`;
      const to = alias.get(e.to) ?? `fstep:${f.id}:${e.to}`;
      const viaStep = alias.has(e.from) ? e.from : alias.has(e.to) ? e.to : null;
      addEdge(from, to, 'feeds', { port: e.port, slot: e.slot, ...(viaStep !== null ? { via: `fstep:${f.id}:${viaStep}` } : {}) });
    }
  }
  // A start_flow trigger draws trigger-runs-entry-step.
  for (const t of triggers) {
    const a = t.action as { type?: string; flow?: string; entry?: string };
    if (a.type !== 'start_flow' || typeof a.entry !== 'string') continue;
    const home = flowRows.find((f) => f.name === (a.flow ?? 'main') && (t.project_id === null || f.project_id === t.project_id));
    if (home !== undefined) addEdge(`trg:${t.id}`, `fstep:${home.id}:${a.entry}`, 'runs');
  }
}
