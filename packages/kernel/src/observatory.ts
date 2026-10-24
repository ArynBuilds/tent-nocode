import type postgres from 'postgres';
import { triggerKindWord } from '@nodeloom/core';
import { projectArm } from './containment.js';
import { paramWord, projectFlowSteps } from './observatorySteps.js';
import { projectPeopleAndNotes } from './observatoryPeople.js';

// One read projecting the org's automation topology from existing rows; pure projection, zero mutations.

export type AutomationNodeKind =
  | 'dataset' | 'operation' | 'output' | 'scene' | 'trigger' | 'chain' | 'role'
  | 'notes'
  | 'integration'
  | 'step';

// Tiny record-derived truth the tile renders instead of the glyph; absent = the glyph.
export type NodeFaceData =
  | { kind: 'grid'; cols: number; rows: number }
  | { kind: 'value'; value: string };

export interface AutomationNode {
  id: string;
  kind: AutomationNodeKind;
  label: string;
  /** Display word the tile renders; label stays the machine identity. */
  word?: string;
  detail: string | null;
  lastActivityAt: string | null;
  /** Project membership for render-side clustering. */
  projectId: string | null;
  /** Living face; present only where a real record truth exists. */
  face?: NodeFaceData;
  /** Service slug behind an integration-shaped node; never rendered as text. */
  service?: string;
  /** Required-but-unfed field names (cap 3) advertised as droppable sockets. */
  sockets?: string[];
  /** Close-zoom face's config rows (plain words, cap 3). */
  grow?: Array<{ k: string; v: string }>;
}

export interface AutomationEdge {
  from: string;
  to: string;
  /** 'may-edit' is the scope wire: the wire is the grant, deleting it revokes. */
  verb: 'feeds' | 'produces' | 'shows' | 'watches' | 'runs' | 'updates' | 'built' | 'may-edit';
  /** A scene-action rule edge's address so its × removes exactly its rule; param marks a field-mapping edge. */
  action?: string;
  rule?: number;
  param?: string;
  /** A step-wire edge's address on its flow doc; the × unwires exactly this edge. */
  port?: string;
  slot?: string;
  /** A fused run-tool step's edge; the × removes that step whole. */
  via?: string;
}

export interface AutomationGraph { nodes: AutomationNode[]; edges: AutomationEdge[] }

// Generic drill-in shape: plain lines the renderer prints verbatim, plus real code for operations.
export interface AutomationDetail {
  title: string;
  kind: AutomationNodeKind;
  lines: Array<{ indent: number; text: string; mono?: boolean }>;
  code: string | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// With a projectId, only that project's citizens render; null = the whole-account read.
export async function orgAutomationGraph(sql: postgres.Sql, orgId: string, projectId: string | null = null): Promise<AutomationGraph> {
  const nodes: AutomationNode[] = [];
  const edges: AutomationEdge[] = [];
  const seen = new Set<string>();
  const addNode = (n: AutomationNode): void => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };
  const addEdge = (from: string, to: string, verb: AutomationEdge['verb'], meta?: { action?: string; rule?: number; param?: string; port?: string; slot?: string; via?: string }): void => {
    if (seen.has(from) && seen.has(to)) edges.push({ from, to, verb, ...(meta ?? {}) });
  };

  const datasets = await sql<{ name: string; display_name: string | null; project_id: string | null; n: string; cols: string; last: Date | null }[]>`
    select d.name, d.display_name, d.project_id, count(r.id) as n,
      (select count(*) from jsonb_object_keys(d.row_schema) k) as cols,
      max(r.created_at) as last
    from datasets d left join dataset_rows r on r.dataset_id = d.id
    where d.org_id = ${orgId} and ${projectArm(sql, projectId, 'd')} and d.deleted_at is null group by d.name, d.display_name, d.project_id, d.row_schema order by d.name`;
  for (const d of datasets) {
    const rows = Number(d.n);
    addNode({
      id: `ds:${d.name}`, kind: 'dataset', label: d.name, detail: `${d.n} rows`,
      ...(d.display_name !== null ? { word: d.display_name } : {}),
      lastActivityAt: iso(d.last), projectId: d.project_id,
      ...(rows > 0 ? { face: { kind: 'grid' as const, cols: Number(d.cols), rows } } : {}),
    });
  }

  const outputs = await sql<{ name: string; kind: string; status: string; project_id: string | null; descriptor: Record<string, unknown> | null; created_at: Date }[]>`
    select distinct on (name) name, kind, status, project_id, descriptor, created_at
    from derived_outputs where org_id = ${orgId} and ${projectArm(sql, projectId)} order by name, created_at desc`;
  for (const o of outputs) {
    // The Result shows its number where the descriptor honestly carries one.
    const n = [o.descriptor?.['rows'], o.descriptor?.['count']].find((v) => typeof v === 'number');
    addNode({
      id: `out:${o.name}`, kind: 'output', label: o.name, detail: o.kind,
      lastActivityAt: iso(o.created_at), projectId: o.project_id,
      ...(typeof n === 'number' ? { face: { kind: 'value' as const, value: n.toLocaleString('en-US') } } : {}),
    });
  }

  const ops = await sql<{ name: string; display_name: string | null; version: number; status: string; project_id: string | null; io_contract: Record<string, unknown> | null }[]>`
    select distinct on (name) name, display_name, version, status, project_id, io_contract from operations
    where org_id = ${orgId} and ${projectArm(sql, projectId)} order by name, version desc`;
  const lastExec = await sql<{ operation: string; status: string; error: string | null; finished_at: Date | null; inputs: Record<string, unknown>; outputs: Record<string, unknown> | null }[]>`
    select distinct on (operation) operation, status, error, finished_at, inputs, outputs
    from operation_executions where org_id = ${orgId} and ${projectArm(sql, projectId)} order by operation, created_at desc`;
  const execByOp = new Map(lastExec.map((e) => [e.operation, e]));
  const opProjects = new Map(ops.filter((o) => o.project_id !== null).map((o) => [o.name, o.project_id as string]));
  for (const o of ops) {
    // The tool's subtitle is its last run's honest word.
    const e = execByOp.get(o.name);
    const runWord = e === undefined ? null
      : e.status === 'failed' ? `failed - ${(e.error ?? 'the run failed').slice(0, 60)}`
        : e.status === 'succeeded' && e.finished_at !== null ? `ran ${e.finished_at.toISOString().slice(11, 16)}`
          : e.status === 'pending' || e.status === 'running' ? 'running…' : null;
    addNode({
      id: `op:${o.name}`, kind: 'operation', label: `${o.name}@${o.version}`,
      detail: runWord ?? o.status, lastActivityAt: iso(e?.finished_at ?? null),
      projectId: o.project_id,
      ...(o.display_name !== null ? { word: o.display_name } : {}),
    });
  }
  // Write-back edges derive from the declared contract, never waiting for a run.
  for (const o of ops) {
    if (o.status !== 'active' || !seen.has(`op:${o.name}`)) continue;
    const outs = (o.io_contract?.['outputs'] ?? {}) as Record<string, { kind?: unknown; dataset?: unknown }>;
    for (const decl of Object.values(outs)) {
      if (decl?.kind === 'dataset' && typeof decl.dataset === 'string') {
        addEdge(`op:${o.name}`, `ds:${decl.dataset}`, 'updates');
      }
    }
  }
  // Data edges from each operation's LATEST execution: input values naming a dataset feed
  // the tool; output values naming a registered output are produced by it.
  for (const [op, e] of execByOp) {
    if (!seen.has(`op:${op}`)) continue;
    for (const v of Object.values(e.inputs ?? {})) {
      if (typeof v === 'string' && seen.has(`ds:${v}`)) addEdge(`ds:${v}`, `op:${op}`, 'feeds');
      if (typeof v === 'string' && seen.has(`out:${v}`)) addEdge(`out:${v}`, `op:${op}`, 'feeds');
    }
    for (const v of Object.values(e.outputs ?? {})) {
      if (typeof v === 'string' && seen.has(`out:${v}`)) addEdge(`op:${op}`, `out:${v}`, 'produces');
    }
  }

  // The project's tabless scene renders as the workspace ground; the tab join keeps it out of the graph.
  const scenes = await sql<{ id: string; title: string; project_id: string | null; bindings: unknown; actions: unknown; last: Date | null }[]>`
    select s.id, s.title, s.project_id, s.bindings, s.actions,
      (select max(v.created_at) from scene_revisions v where v.scene_id = s.id) as last
    from scenes s where s.org_id = ${orgId} and ${projectArm(sql, projectId, 's')} and s.status <> 'deleted'
      and exists (select 1 from tabs t where t.scene_id = s.id)`;
  for (const s of scenes) {
    addNode({
      id: `scene:${s.id}`, kind: 'scene', label: s.title, detail: null, lastActivityAt: iso(s.last),
      projectId: s.project_id,
    });
    const binds = Array.isArray(s.bindings) ? (s.bindings as Array<Record<string, unknown>>) : [];
    for (const b of binds) {
      const ds = typeof b['dataset'] === 'string' ? (b['dataset'] as string) : null;
      // Array/raster bindings carry their output in the source arm.
      const src = typeof b['source'] === 'object' && b['source'] !== null ? (b['source'] as Record<string, unknown>) : null;
      const out = typeof b['output'] === 'string' ? (b['output'] as string)
        : src !== null && src['from'] === 'output' && typeof src['output'] === 'string' ? (src['output'] as string) : null;
      if (ds !== null) addEdge(`ds:${ds}`, `scene:${s.id}`, 'shows');
      if (out !== null) addEdge(`out:${out}`, `scene:${s.id}`, 'shows');
    }
  }

  // Paused triggers stay on the map wearing their reason.
  const triggers = await sql<{ id: string; kind: string; spec: Record<string, unknown>; action: Record<string, unknown>; project_id: string | null; created_at: Date; enabled: boolean; edge_state: Record<string, unknown> | null }[]>`
    select id, kind, spec, action, project_id, created_at, enabled, edge_state from triggers
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and revoked_at is null`;
  for (const t of triggers) {
    const es = t.edge_state ?? {};
    const specBits = [t.spec['dataset'], t.spec['column'], t.spec['path'], t.spec['output']]
      .filter((x): x is string => typeof x === 'string');
    const fired = typeof es['lastFiredAt'] === 'string'
      ? `fired ${es['lastFiredAt'].slice(11, 16)}${typeof es['lastFireCount'] === 'number' ? ` · ${es['lastFireCount']} ${es['lastFireCount'] === 1 ? 'row' : 'rows'}` : ''}`
      : null;
    const detail = !t.enabled
      ? `paused${typeof es['pausedReason'] === 'string' ? ` - ${es['pausedReason'].slice(0, 60)}` : ''}`
      : fired ?? (specBits.join(' · ') || null);
    addNode({ id: `trg:${t.id}`, kind: 'trigger', label: t.kind.replace(/_/g, ' '), word: triggerKindWord(t.kind), detail, lastActivityAt: iso(t.created_at), projectId: t.project_id });
    const wds = t.spec['dataset'];
    if (typeof wds === 'string') addEdge(`trg:${t.id}`, `ds:${wds}`, 'watches');
    const wout = t.spec['output'];
    if (typeof wout === 'string') addEdge(`trg:${t.id}`, `out:${wout}`, 'watches');
    const actOp = t.action['operation'];
    if (typeof actOp === 'string') addEdge(`trg:${t.id}`, `op:${actOp}`, 'runs');
  }

  const chains = await sql<{ id: string; operation: string; watch: unknown; project_id: string | null; created_at: Date }[]>`
    select id, operation, watch, project_id, created_at from reactive_chains
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and revoked_at is null and enabled`;
  for (const c of chains) {
    addNode({ id: `chain:${c.id}`, kind: 'chain', label: `re-runs ${c.operation}`, detail: null, lastActivityAt: iso(c.created_at), projectId: c.project_id });
    const watches = Array.isArray(c.watch) ? c.watch : [c.watch];
    for (const w of watches) {
      if (typeof w === 'string') {
        if (seen.has(`out:${w}`)) addEdge(`out:${w}`, `chain:${c.id}`, 'updates');
        if (seen.has(`ds:${w}`)) addEdge(`ds:${w}`, `chain:${c.id}`, 'updates');
      }
    }
    if (seen.has(`op:${c.operation}`)) addEdge(`chain:${c.id}`, `op:${c.operation}`, 'runs');
  }

  // One node per live connection row; the detail is the honest status.
  const connections = await sql<{ id: string; integration: string; label: string; status: string; project_id: string; inside: { tables?: Record<string, string> }; settings: Record<string, unknown> | null; created_at: Date }[]>`
    select id, integration, label, status, project_id, inside, settings, created_at from integration_connections
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and revoked_at is null`;
  if (connections.length > 0) {
    const lastCall = await sql<{ connection_id: string; finished_at: Date | null }[]>`
      select distinct on (connection_id) connection_id, finished_at from integration_executions
      where org_id = ${orgId} order by connection_id, created_at desc`;
    const callBy = new Map(lastCall.map((c) => [c.connection_id, c.finished_at]));
    for (const c of connections) {
      // The Connection's close-zoom rows: its own settings in plain words.
      const grow = Object.entries(c.settings ?? {}).slice(0, 3).map(([k, v]) => ({ k, v: paramWord(v) }));
      addNode({
        id: `intg:${c.id}`, kind: 'integration', label: c.label,
        detail: c.status === 'active' ? 'connected' : 'not connected yet',
        lastActivityAt: iso(callBy.get(c.id) ?? c.created_at), projectId: c.project_id,
        service: c.integration,
        ...(grow.length > 0 ? { grow } : {}),
      });
      // Born inside tables draw as the node's own feed edges.
      for (const dsName of Object.values(c.inside?.tables ?? {})) {
        addEdge(`intg:${c.id}`, `ds:${dsName}`, 'updates');
      }
    }
    // A call_integration trigger action draws trigger-runs-connection and lends the trigger its service.
    for (const t of triggers) {
      const actConn = t.action['connection'];
      if (typeof actConn !== 'string') continue;
      addEdge(`trg:${t.id}`, `intg:${actConn}`, 'runs');
      const trgNode = nodes.find((n) => n.id === `trg:${t.id}`);
      const conn = connections.find((c) => c.id === actConn);
      if (trgNode !== undefined && conn !== undefined) trgNode.service = conn.integration;
    }
  }

  // The step projection lives in observatorySteps.ts.
  await projectFlowSteps(sql, { orgId, projectId, addNode, addEdge, connections, triggers });

  // One edge per scene-action rule; each carries {action, rule} so its × removes exactly its rule.
  const { resolveIntegrationDef } = await import('./integrations/catalog.js');
  // The first rule firing through a connection advertises its required-but-unfed fields as sockets.
  const socketIntg = (connId: string, endpoint: unknown, ruleParams: unknown): void => {
    const node = nodes.find((n) => n.id === `intg:${connId}`);
    const conn = connections.find((c) => c.id === connId);
    if (node === undefined || node.sockets !== undefined || conn === undefined || typeof endpoint !== 'string') return;
    const door = resolveIntegrationDef(conn.integration)?.endpoints.find((e) => e.id === endpoint);
    if (door === undefined) return;
    const fed = new Set([
      ...(typeof ruleParams === 'object' && ruleParams !== null ? Object.keys(ruleParams) : []),
      ...Object.keys(conn.settings ?? {}).flatMap((k) => [k, k.replace(/^default_/, '')]),
    ]);
    const open = Object.entries(door.params)
      .filter(([k, p]) => (p as { required?: boolean }).required === true && !fed.has(k))
      .map(([k]) => k).slice(0, 3);
    if (open.length > 0) node.sockets = open;
  };
  for (const s of scenes) {
    const acts = Array.isArray(s.actions) ? (s.actions as Array<Record<string, unknown>>) : [];
    for (const a of acts) {
      const name = typeof a['name'] === 'string' ? (a['name'] as string) : null;
      if (name === null) continue;
      const rules = Array.isArray(a['rules']) ? (a['rules'] as Array<Record<string, unknown>>) : [];
      rules.forEach((r, i) => {
        const kind = r['rule'];
        if ((kind === 'append_row' || kind === 'update_row' || kind === 'delete_row') && typeof r['dataset'] === 'string') {
          addEdge(`scene:${s.id}`, `ds:${r['dataset']}`, 'updates', { action: name, rule: i });
        } else if (kind === 'run_operation' && typeof r['operation'] === 'string') {
          addEdge(`scene:${s.id}`, `op:${r['operation']}`, 'runs', { action: name, rule: i });
        } else if (kind === 'call_integration' && typeof r['connection'] === 'string') {
          addEdge(`scene:${s.id}`, `intg:${r['connection']}`, 'runs', { action: name, rule: i });
          socketIntg(r['connection'], r['operation'], r['params']);
          // One feeds edge per explicit field mapping; its × unmaps exactly that field.
          const params = typeof r['params'] === 'object' && r['params'] !== null && !Array.isArray(r['params'])
            ? (r['params'] as Record<string, unknown>) : {};
          for (const key of Object.keys(params)) {
            addEdge(`scene:${s.id}`, `intg:${r['connection']}`, 'feeds', { action: name, rule: i, param: key });
          }
        }
      });
    }
  }

  // People, scope grants, and notes projections live in observatoryPeople.ts.
  await projectPeopleAndNotes(sql, { orgId, projectId, nodes, seen, addNode, addEdge, opProjects });

  return { nodes, edges };
}

// A project has an Assistant when a live role worked its threads or one was declared by import.
export async function projectHasAssistant(sql: postgres.Sql, orgId: string, projectId: string): Promise<boolean> {
  const [row] = await sql<{ yes: boolean }[]>`
    select (
      exists (
        select 1
        from agents ag
        join runs r on r.agent_id = ag.id
        join threads th on th.id = r.thread_id
        where ag.org_id = ${orgId} and ag.reserved is null and ag.status = 'active'
          and th.project_id = ${projectId}
      )
      or exists (
        select 1 from events e
        where e.org_id = ${orgId} and e.type = 'assistant.declared'
          and e.payload->>'projectId' = ${projectId}
      )
    ) as yes`;
  return row?.yes === true;
}

// The assistant's name: the most recently active worked role, else the latest declared name.
export async function projectAssistantName(sql: postgres.Sql, orgId: string, projectId: string): Promise<string | null> {
  const [role] = await sql<{ slug: string }[]>`
    select ag.slug
    from agents ag
    join runs r on r.agent_id = ag.id
    join threads th on th.id = r.thread_id
    where ag.org_id = ${orgId} and ag.reserved is null and ag.status = 'active'
      and th.project_id = ${projectId}
    group by ag.slug
    order by max(r.finished_at) desc nulls first limit 1`;
  if (role) return role.slug;
  const [declared] = await sql<{ name: string | null }[]>`
    select e.payload->>'name' as name from events e
    where e.org_id = ${orgId} and e.type = 'assistant.declared'
      and e.payload->>'projectId' = ${projectId}
    order by e.id desc limit 1`;
  return declared?.name ?? null;
}

// automationNodeDetail lives in observatoryDetail.ts; re-exported so every consumer stands.
export { automationNodeDetail } from './observatoryDetail.js';
