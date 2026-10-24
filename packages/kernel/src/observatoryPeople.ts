import type postgres from 'postgres';
import { parseDatasetGrant } from '@nodeloom/core';
import type { AutomationEdge, AutomationNode } from './observatory.js';

// Staff, scope-grant, and notes projections for the automation graph.

export async function projectPeopleAndNotes(sql: postgres.Sql, input: {
  orgId: string;
  projectId: string | null;
  nodes: AutomationNode[];
  seen: Set<string>;
  addNode: (n: AutomationNode) => void;
  addEdge: (from: string, to: string, verb: AutomationEdge['verb']) => void;
  opProjects: Map<string, string>;
}): Promise<void> {
  const { orgId, projectId, nodes, seen, addNode, addEdge, opProjects } = input;
  const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
  // One role node per (role, project) its runs served; a never-used role renders nowhere.
  const roleProjects = await sql<{ slug: string; project_id: string; live: Date | null; last: Date | null }[]>`
    select ag.slug, th.project_id,
      max(r.heartbeat_at) filter (where r.status = 'running') as live,
      max(r.finished_at) as last
    from agents ag
    join runs r on r.agent_id = ag.id
    join threads th on th.id = r.thread_id
    where ag.org_id = ${orgId} and ag.reserved is null and ag.status = 'active'
      and th.project_id is not null and ${projectId === null ? sql`true` : sql`th.project_id = ${projectId}`}
    group by ag.slug, th.project_id`;
  for (const r of roleProjects) {
    addNode({
      id: `role:${r.slug}@${r.project_id}`, kind: 'role', label: r.slug,
      detail: r.live !== null ? 'working now' : null,
      lastActivityAt: iso(r.live ?? r.last),
      projectId: r.project_id,
    });
  }
  const authored = await sql<{ name: string; slug: string }[]>`
    select distinct o.name, ag.slug
    from operations o
    join runs r on r.id = o.provenance_run_id
    join agents ag on ag.id = r.agent_id
    where o.org_id = ${orgId} and ag.reserved is null and ag.status = 'active'`;
  for (const a of authored) {
    const opProj = opProjects.get(a.name) ?? null;
    if (opProj !== null && seen.has(`role:${a.slug}@${opProj}`)) {
      addEdge(`role:${a.slug}@${opProj}`, `op:${a.name}`, 'built');
    } else if (seen.has(`op:${a.name}`)) {
      // Projectless provenance: the role rides its operation's cluster through the edge.
      addNode({ id: `role:${a.slug}`, kind: 'role', label: a.slug, detail: null, lastActivityAt: null, projectId: null });
      addEdge(`role:${a.slug}`, `op:${a.name}`, 'built');
    }
  }

  // Dataset-scoped standing grants (impact subjects in the one consent store) project as may-edit wires.
  const impactRows = await sql<{ subject: string }[]>`
    select subject from consent_grants
    where org_id = ${orgId} and subject like 'impact:%' and revoked_at is null`;
  const activeAgents = await sql<{ id: string; slug: string }[]>`
    select id, slug from agents
    where org_id = ${orgId} and reserved is null and status = 'active'`;
  const slugById = new Map(activeAgents.map((a) => [a.id, a.slug]));
  const scopeGrants = impactRows.flatMap((r) => {
    const m = /^impact:([0-9a-f-]{36}):(.+)$/i.exec(r.subject);
    const slug = m === null ? undefined : slugById.get(m[1]!);
    return m !== null && slug !== undefined ? [{ slug, action: m[2]! }] : [];
  });
  for (const g of scopeGrants) {
    const dataset = parseDatasetGrant(g.action);
    if (dataset === null || !seen.has(`ds:${dataset}`)) continue;
    const withProject = nodes.find((n) => n.kind === 'role' && n.label === g.slug);
    const roleId = withProject?.id ?? `role:${g.slug}`;
    if (!seen.has(roleId)) {
      addNode({ id: roleId, kind: 'role', label: g.slug, detail: null, lastActivityAt: null, projectId: null });
    }
    addEdge(roleId, `ds:${dataset}`, 'may-edit');
  }

  // One notes node per project on the canvas or holding notes.
  const onCanvas = new Set<string>();
  for (const n of nodes) if (n.projectId !== null) onCanvas.add(n.projectId);
  const noteProjects = await sql<{ id: string; name: string; n: string; last: Date | null }[]>`
    select p.id, p.name,
      (select count(*) from project_notes pn where pn.project_id = p.id and pn.superseded_by is null and pn.deleted_at is null) as n,
      (select max(pn.created_at) from project_notes pn where pn.project_id = p.id and pn.deleted_at is null) as last
    from projects p
    where p.org_id = ${orgId} and ${projectId === null ? sql`true` : sql`p.id = ${projectId}`} and p.archived_at is null`;
  for (const p of noteProjects) {
    const count = Number(p.n);
    if (count === 0 && !onCanvas.has(p.id)) continue;
    const name = p.name.replace(/\s+/g, ' ').slice(0, 36);
    addNode({
      id: `notes:${p.id}`, kind: 'notes', label: 'Notes',
      detail: count > 0 ? `${count} note${count === 1 ? '' : 's'} · ${name}` : name,
      lastActivityAt: iso(p.last), projectId: p.id,
    });
  }

}
