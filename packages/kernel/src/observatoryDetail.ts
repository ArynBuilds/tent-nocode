import type postgres from 'postgres';
import { readNotes } from './notes.js';
import type { AutomationDetail } from './observatory.js';

// Node drill-in detail: plain lines derived from stored rows, plus real code for operations.

const short = (v: unknown, max = 46): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '' : s.length > max ? s.slice(0, max - 1) + '…' : s;
};

export async function automationNodeDetail(
  sql: postgres.Sql,
  input: { orgId: string; nodeId: string },
): Promise<AutomationDetail | null> {
  const { orgId, nodeId } = input;
  const sep = nodeId.indexOf(':');
  const prefix = nodeId.slice(0, sep);
  const key = nodeId.slice(sep + 1);
  const L = (indent: number, text: string, mono?: boolean) => ({ indent, text, ...(mono ? { mono: true } : {}) });

  if (prefix === 'ds') {
    const [d] = await sql<{ row_schema: Record<string, string>; n: string }[]>`
      select d.row_schema, (select count(*) from dataset_rows r where r.dataset_id = d.id) as n
      from datasets d where d.org_id = ${orgId} and d.name = ${key} and d.deleted_at is null`;
    if (!d) return null;
    const lines = [L(0, `${Number(d.n).toLocaleString('en-US')} rows`)];
    for (const [col, type] of Object.entries(d.row_schema)) lines.push(L(1, `${col} · ${type}`, true));
    return { title: key, kind: 'dataset', lines, code: null };
  }

  if (prefix === 'op') {
    const [o] = await sql<{ version: number; status: string; runtime: string; code: string; io_contract: { inputs: Record<string, { type: string; description?: string }>; outputs: Record<string, { kind: string; description?: string }> } }[]>`
      select version, status, runtime, code, io_contract from operations
      where org_id = ${orgId} and name = ${key} order by version desc limit 1`;
    if (!o) return null;
    const lines = [L(0, `v${o.version} · ${o.status} · ${o.runtime} runtime (sealed)`)];
    lines.push(L(0, 'takes:'));
    for (const [k, v] of Object.entries(o.io_contract.inputs ?? {})) lines.push(L(1, `${k} · ${v.type}${v.description ? ` — ${short(v.description)}` : ''}`, true));
    lines.push(L(0, 'produces:'));
    for (const [k, v] of Object.entries(o.io_contract.outputs ?? {})) lines.push(L(1, `${k} · ${v.kind}${v.description ? ` — ${short(v.description)}` : ''}`, true));
    return { title: `${key}@${o.version}`, kind: 'operation', lines, code: o.code };
  }

  if (prefix === 'out') {
    const [d] = await sql<{ kind: string; status: string; descriptor: Record<string, unknown> }[]>`
      select kind, status, descriptor from derived_outputs
      where org_id = ${orgId} and name = ${key} order by created_at desc limit 1`;
    if (!d) return null;
    const lines = [L(0, `${d.kind} · ${d.status}`)];
    for (const [k, v] of Object.entries(d.descriptor ?? {})) lines.push(L(1, `${k}: ${short(v)}`, true));
    return { title: key, kind: 'output', lines, code: null };
  }

  if (prefix === 'intg') {
    // The Connection's anatomy: status, endpoints grouped by class, and the settings that hold.
    const [c] = await sql<{ integration: string; version: number; label: string; status: string; owner_host: string | null; settings: Record<string, unknown>; inside: { tables?: Record<string, string> } }[]>`
      select integration, version, label, status, owner_host, settings, inside
      from integration_connections where org_id = ${orgId} and id = ${key} and revoked_at is null`;
    if (!c) return null;
    const { resolveIntegrationDef } = await import('./integrations/catalog.js');
    const def = resolveIntegrationDef(c.integration, c.version);
    const lines = [L(0, c.status === 'active' ? 'connected' : 'not connected yet - connect it to start')];
    if (c.owner_host !== null) lines.push(L(1, `sends to ${c.owner_host}`, true));
    if (def) {
      for (const klass of ['read', 'write', 'send'] as const) {
        const of = def.endpoints.filter((e) => e.class === klass);
        if (of.length === 0) continue;
        lines.push(L(0, `${klass}s:`));
        for (const e of of) lines.push(L(1, e.displayName));
      }
    }
    const insideTables = Object.values(c.inside?.tables ?? {});
    if (insideTables.length > 0) {
      lines.push(L(0, 'lands in:'));
      for (const name of insideTables) lines.push(L(1, name, true));
    }
    const settingKeys = Object.keys(c.settings ?? {});
    if (settingKeys.length > 0) {
      lines.push(L(0, 'set up:'));
      for (const k of settingKeys) lines.push(L(1, `${k}: ${short(c.settings[k])}`, true));
    }
    // The last-call line reads back from the record's own row.
    const [last] = await sql<{ endpoint: string; status: string; error: string | null; result: unknown; finished_at: Date | null }[]>`
      select endpoint, status, error, result, finished_at from integration_executions
      where org_id = ${orgId} and connection_id = ${key} order by created_at desc limit 1`;
    if (last) {
      const doorWord = def?.endpoints.find((e) => e.id === last.endpoint)?.displayName ?? last.endpoint;
      lines.push(L(0, 'last call:'));
      if (last.status === 'succeeded') {
        const bits = typeof last.result === 'object' && last.result !== null
          ? Object.entries(last.result as Record<string, unknown>).slice(0, 3).map(([k, v]) => `${k}: ${short(v, 40)}`).join(' · ')
          : '';
        lines.push(L(1, `'${doorWord}' answered${bits !== '' ? ` — ${bits}` : ''}`));
      } else if (last.status === 'failed') {
        lines.push(L(1, `'${doorWord}' — ${last.error ?? 'failed'}`));
      } else {
        lines.push(L(1, `'${doorWord}' — still running`));
      }
    }
    return { title: c.label, kind: 'integration', lines, code: null };
  }

  if (prefix === 'fstep') {
    // The step's anatomy: its def's plain words plus the stored params.
    const at = key.indexOf(':');
    const flowId = key.slice(0, at);
    const stepId = key.slice(at + 1);
    const [f] = await sql<{ doc: { steps?: Record<string, { kind?: string; params?: Record<string, unknown>; disabled?: boolean }> } }[]>`
      select doc from flows where org_id = ${orgId} and id = ${flowId} and deleted_at is null`;
    const step = f?.doc.steps?.[stepId];
    if (!f || step === undefined) return null;
    const { resolveFlowStepDef } = await import('./flows/registry.js');
    const def = step.kind !== undefined ? resolveFlowStepDef(step.kind) : null;
    const lines = [L(0, step.disabled === true ? 'switched off — items pass through untouched' : def?.blurb ?? 'a step')];
    // A configured call-integration step speaks the door's words, never raw ids.
    let title = def?.displayName ?? stepId;
    if (step.kind === 'call-integration') {
      const connId = typeof step.params?.['connection'] === 'string' ? step.params['connection'] : '';
      const endpoint = typeof step.params?.['endpoint'] === 'string' ? step.params['endpoint'] : '';
      if (connId !== '' && endpoint !== '') {
        const [conn] = await sql<{ integration: string; label: string }[]>`
          select integration, label from integration_connections
          where org_id = ${orgId} and id = ${connId} and revoked_at is null`;
        if (conn) {
          const { resolveIntegrationDef } = await import('./integrations/catalog.js');
          const idef = resolveIntegrationDef(conn.integration);
          const doorWord = idef?.endpoints.find((e) => e.id === endpoint)?.displayName ?? endpoint;
          title = `${idef?.displayName ?? conn.integration}: ${doorWord}`;
          lines.push(L(0, `through ${conn.label} · door '${doorWord}'`));
        }
      }
    }
    const params = Object.entries(step.params ?? {})
      .filter(([k]) => !(step.kind === 'call-integration' && (k === 'connection' || k === 'endpoint')));
    if (params.length > 0) {
      lines.push(L(0, 'set up:'));
      for (const [k, v] of params) lines.push(L(1, `${k}: ${short(v)}`, true));
    }
    return { title, kind: 'step', lines, code: null };
  }

  if (prefix === 'scene') {
    const [s] = await sql<{ title: string; document: { nodes?: Record<string, { id: string; parent: string | null; order: string; components?: Record<string, Record<string, unknown>> }> }; bindings: unknown }[]>`
      select title, document, bindings from scenes where org_id = ${orgId} and id = ${key}`;
    if (!s) return null;
    const lines: AutomationDetail['lines'] = [];
    const binds = Array.isArray(s.bindings) ? (s.bindings as Array<Record<string, unknown>>) : [];
    if (binds.length) {
      lines.push(L(0, 'fed by:'));
      for (const b of binds) lines.push(L(1, `${short(b['name'])} ⇐ ${short(b['dataset'] ?? b['output'] ?? b['kind'])}`, true));
    }
    lines.push(L(0, 'the component tree, node by node:'));
    const all = Object.values(s.document.nodes ?? {});
    const kids = new Map<string | null, typeof all>();
    for (const n of all) {
      const list = kids.get(n.parent) ?? [];
      list.push(n);
      kids.set(n.parent, list);
    }
    const walk = (parent: string | null, depth: number): void => {
      const list = (kids.get(parent) ?? []).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
      for (const n of list) {
        const refs = Object.entries(n.components ?? {});
        if (refs.length === 0) lines.push(L(depth + 1, `${n.id}`, true));
        for (const [ref, payload] of refs) {
          const bits = Object.entries(payload ?? {}).slice(0, 3)
            .map(([k, v]) => `${k}=${short(v, 22)}`).join(' · ');
          lines.push(L(depth + 1, `${ref}${bits ? `  (${bits})` : ''}`, true));
        }
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return { title: s.title, kind: 'scene', lines, code: null };
  }

  if (prefix === 'trg') {
    const [t] = await sql<{ kind: string; spec: Record<string, unknown>; action: Record<string, unknown>; enabled: boolean }[]>`
      select kind, spec, action, enabled from triggers where org_id = ${orgId} and id = ${key}`;
    if (!t) return null;
    const lines = [L(0, `${t.kind.replace(/_/g, ' ')} · ${t.enabled ? 'armed' : 'disabled'}`)];
    lines.push(L(0, 'watches:'));
    for (const [k, v] of Object.entries(t.spec ?? {})) lines.push(L(1, `${k}: ${short(v)}`, true));
    lines.push(L(0, `then: ${short(t.action['kind'] ?? t.action['operation'] ?? 'raises its action', 60)}`));
    return { title: t.kind.replace(/_/g, ' '), kind: 'trigger', lines, code: null };
  }

  if (prefix === 'chain') {
    const [c] = await sql<{ operation: string; watch: unknown; inputs: Record<string, unknown>; enabled: boolean }[]>`
      select operation, watch, inputs, enabled from reactive_chains where org_id = ${orgId} and id = ${key}`;
    if (!c) return null;
    const lines = [
      L(0, c.enabled ? 'armed' : 'disabled'),
      L(0, `when ${short(Array.isArray(c.watch) ? c.watch.join(', ') : c.watch, 60)} changes`),
      L(0, `re-runs ${c.operation}`, true),
    ];
    return { title: `re-runs ${c.operation}`, kind: 'chain', lines, code: null };
  }

  if (prefix === 'role') {
    // Project-wise role ids carry `@<projectId>`; the slug is the part before it.
    const at = key.lastIndexOf('@');
    const slug = at > 0 ? key.slice(0, at) : key;
    const [a] = await sql<{ id: string; status: string; current_version: number; created_at: Date; runs: string; last: Date | null }[]>`
      select a.id, a.status, a.current_version, a.created_at,
        (select count(*) from runs r where r.agent_id = a.id) as runs,
        (select max(r.finished_at) from runs r where r.agent_id = a.id) as last
      from agents a where a.org_id = ${orgId} and a.slug = ${slug}`;
    if (!a) return null;
    return {
      title: slug, kind: 'role',
      lines: [
        L(0, `${a.status} · charter v${a.current_version}`),
        L(0, `${Number(a.runs)} runs · last ${a.last ? a.last.toISOString().slice(0, 16).replace('T', ' ') : '—'}`),
      ],
      code: null,
    };
  }

  if (prefix === 'notes') {
    // The notes node's read-only anatomy: the project's living notes.
    const [p] = await sql<{ name: string }[]>`
      select name from projects where org_id = ${orgId} and id = ${key} and archived_at is null`;
    if (!p) return null;
    const notes = await readNotes(sql, { orgId, projectId: key, limit: 50 });
    const lines: AutomationDetail['lines'] = [
      L(0, notes.length > 0
        ? `${notes.length} note${notes.length === 1 ? '' : 's'} · corrections supersede, never edit in place`
        : 'no notes yet — decisions, lessons and constraints land here as plain sentences'),
    ];
    for (const n of notes) {
      lines.push(L(0, n.body.replace(/\s+/g, ' ')));
      lines.push(L(1, `${n.author} · ${n.createdAt.slice(0, 10)}`, true));
    }
    return { title: `Notes — ${p.name.replace(/\s+/g, ' ').slice(0, 60)}`, kind: 'notes', lines, code: null };
  }

  return null;
}
