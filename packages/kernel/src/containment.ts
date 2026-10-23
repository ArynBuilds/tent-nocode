import type postgres from 'postgres';

// Resolves which project a reference belongs to, most-specific-first: projectId, scene, thread, run; null = the whole-account serving lane.
export async function resolveProject(
  sql: postgres.Sql,
  ref: {
    orgId: string;
    projectId?: string | null;
    sceneId?: string | null;
    sceneSlug?: string | null;
    threadId?: string | null;
    runId?: string | null;
  },
): Promise<string | null> {
  if (ref.projectId !== undefined && ref.projectId !== null) return ref.projectId;
  if (ref.sceneId !== undefined && ref.sceneId !== null) {
    const [s] = await sql<{ project_id: string | null }[]>`
      select project_id from scenes where id = ${ref.sceneId} and org_id = ${ref.orgId}`;
    if (s?.project_id != null) return s.project_id;
  }
  if (ref.sceneSlug !== undefined && ref.sceneSlug !== null) {
    const [s] = await sql<{ project_id: string | null }[]>`
      select project_id from scenes
      where org_id = ${ref.orgId} and slug = ${ref.sceneSlug} and status != 'deleted'
      order by created_at desc limit 1`;
    if (s?.project_id != null) return s.project_id;
  }
  if (ref.threadId !== undefined && ref.threadId !== null) {
    const [t] = await sql<{ project_id: string | null }[]>`
      select project_id from threads where id = ${ref.threadId} and org_id = ${ref.orgId}`;
    if (t?.project_id != null) return t.project_id;
  }
  if (ref.runId !== undefined && ref.runId !== null) {
    const [r] = await sql<{ project_id: string | null }[]>`
      select th.project_id from runs r
      join threads th on th.id = r.thread_id
      where r.id = ${ref.runId} and r.org_id = ${ref.orgId}`;
    if (r?.project_id != null) return r.project_id;
  }
  return null;
}

// The project-scope WHERE arm name-readers compose; qualifier is the table alias or '' for unqualified.
export function projectArm(
  sql: postgres.Sql, projectId: string | null, qualifier = '',
): postgres.PendingQuery<postgres.Row[]> {
  if (projectId === null) return sql`true`;
  // The qualifier is code-authored (a literal at each call site), never caller input;
  // the projectId itself always rides as a bound parameter.
  switch (qualifier) {
    case 'd': return sql`d.project_id = ${projectId}`;
    case 't': return sql`t.project_id = ${projectId}`;
    case 's': return sql`s.project_id = ${projectId}`;
    case 'o': return sql`o.project_id = ${projectId}`;
    case 'e': return sql`e.project_id = ${projectId}`;
    case 'cd': return sql`cd.project_id = ${projectId}`;
    default: return sql`project_id = ${projectId}`;
  }
}
