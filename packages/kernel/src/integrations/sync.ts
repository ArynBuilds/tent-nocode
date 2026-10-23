// Scheduled mirror pull: fires each active connection's declared sync endpoint on its cadence.
import type postgres from 'postgres';
import { resolveIntegrationDef } from './catalog.js';
import { runIntegrationCall } from './dispatch.js';

// One sweep: enqueue the due mirrors; returns how many were queued.
export async function sweepDueMirrors(sql: postgres.Sql): Promise<number> {
  const connections = await sql<{ id: string; org_id: string; integration: string; version: number }[]>`
    select id, org_id, integration, version from integration_connections
    where status = 'active' and revoked_at is null`;
  let queued = 0;
  for (const c of connections) {
    const def = resolveIntegrationDef(c.integration, c.version);
    if (!def || def.sync === undefined) continue;
    const [last] = await sql<{ created_at: Date }[]>`
      select created_at from integration_executions
      where connection_id = ${c.id} and endpoint = ${def.sync.endpoint} and trigger->>'kind' = 'sync'
      order by created_at desc limit 1`;
    if (last && Date.now() - new Date(last.created_at).getTime() < def.sync.everyMinutes * 60 * 1000) continue;
    // Params ride empty; dispatch fills them from the node's settings.
    const res = await runIntegrationCall(sql, {
      orgId: c.org_id, connectionId: c.id, endpoint: def.sync.endpoint,
      params: {}, trigger: { kind: 'sync' }, createdBy: 'sync',
    });
    if (res.ok) queued += 1;
  }
  return queued;
}
