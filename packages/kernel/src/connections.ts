import type postgres from 'postgres';
import { emitEvent } from './events.js';

// MCP connections: a curated gallery plus org registry rows that snapshot the command verbatim; tokens never pass through here.

export interface McpServiceSpec {
  id: string;
  title: string;
  blurb: string;
  command: readonly string[];
  secretName: string;
  // The env var the external server expects the token in; injected in main, model-invisible.
  secretEnv: string;
  tokenHelp: string;
  defaultRules: readonly { pattern: string; effect: 'allow' | 'ask' }[];
}

export const MCP_GALLERY: readonly McpServiceSpec[] = [
  {
    id: 'supabase',
    title: 'Supabase',
    blurb: 'Query projects, run SQL, and manage your Supabase account through its official MCP server.',
    command: ['npx', '-y', '@supabase/mcp-server-supabase@latest'],
    secretName: 'SUPABASE_ACCESS_TOKEN',
    secretEnv: 'SUPABASE_ACCESS_TOKEN',
    tokenHelp: 'Supabase dashboard → Account → Access Tokens → Generate new token',
    defaultRules: [
      { pattern: 'mcp__ext-supabase__list_*', effect: 'allow' },
      { pattern: 'mcp__ext-supabase__get_*', effect: 'allow' },
      { pattern: 'mcp__ext-supabase__*', effect: 'ask' },
    ],
  },
  {
    id: 'github',
    title: 'GitHub',
    blurb: 'Read repos, issues, and PRs — and with your consent, write them — through the GitHub MCP server.',
    command: ['npx', '-y', '@modelcontextprotocol/server-github'],
    secretName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    secretEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    tokenHelp: 'GitHub → Settings → Developer settings → Personal access tokens (fine-grained; pick the repos Tent NoCode may see)',
    defaultRules: [
      { pattern: 'mcp__ext-github__search_*', effect: 'allow' },
      { pattern: 'mcp__ext-github__get_*', effect: 'allow' },
      { pattern: 'mcp__ext-github__list_*', effect: 'allow' },
      { pattern: 'mcp__ext-github__*', effect: 'ask' },
    ],
  },
  // Vercel is deliberately absent: its official MCP server is remote+OAuth.
];

export function resolveGalleryService(id: string): McpServiceSpec | null {
  return MCP_GALLERY.find((s) => s.id === id) ?? null;
}

export interface ConnectionRow {
  id: string;
  serviceId: string;
  title: string;
  command: string[];
  secretName: string;
  secretEnv: string;
  defaultRules: { pattern: string; effect: 'allow' | 'ask' }[];
  createdAt: string;
}

export async function addConnection(
  sql: postgres.Sql,
  input: {
    orgId: string; serviceId: string; createdBy: string;
    // A custom server's full spec, collected by the consent card.
    custom?: { title: string; command: string[]; secretName: string; secretEnv: string; defaultRules: { pattern: string; effect: 'allow' | 'ask' }[] };
  },
): Promise<{ connectionId: string }> {
  let snapshot: { title: string; command: readonly string[]; secretName: string; secretEnv: string; defaultRules: readonly { pattern: string; effect: 'allow' | 'ask' }[] };
  if (input.custom) {
    snapshot = input.custom;
  } else {
    const spec = resolveGalleryService(input.serviceId);
    if (!spec) throw new Error(`unknown service '${input.serviceId}' — not in the curated gallery (custom servers require their full spec via the consent card)`);
    snapshot = spec;
  }
  const [row] = await sql<{ id: string }[]>`
    insert into connections (org_id, service_id, title, command, secret_name, secret_env, default_rules, created_by)
    values (${input.orgId}, ${input.serviceId}, ${snapshot.title}, ${sql.json(snapshot.command as string[])},
            ${snapshot.secretName}, ${snapshot.secretEnv}, ${sql.json(snapshot.defaultRules as postgres.JSONValue)}, ${input.createdBy})
    returning id`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.connections', type: 'connection.added',
    payload: { connectionId: row!.id, serviceId: input.serviceId, title: snapshot.title, command: snapshot.command },
  });
  return { connectionId: row!.id };
}

export async function listConnections(sql: postgres.Sql, orgId: string): Promise<ConnectionRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select id, service_id, title, command, secret_name, secret_env, default_rules, created_at
    from connections where org_id = ${orgId} and revoked_at is null
    order by created_at asc`;
  return rows.map((r) => ({
    id: r['id'] as string, serviceId: r['service_id'] as string, title: r['title'] as string,
    command: r['command'] as string[], secretName: r['secret_name'] as string,
    secretEnv: r['secret_env'] as string,
    defaultRules: r['default_rules'] as { pattern: string; effect: 'allow' | 'ask' }[],
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));
}

export async function revokeConnection(
  sql: postgres.Sql, input: { orgId: string; connectionId: string; revokedBy: string },
): Promise<void> {
  const [row] = await sql<{ service_id: string }[]>`
    update connections set revoked_at = now()
    where id = ${input.connectionId} and org_id = ${input.orgId} and revoked_at is null
    returning service_id`;
  if (!row) throw new Error(`connection not found or already revoked: ${input.connectionId}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.connections', type: 'connection.revoked',
    payload: { connectionId: input.connectionId, serviceId: row.service_id, revokedBy: input.revokedBy },
  });
}
