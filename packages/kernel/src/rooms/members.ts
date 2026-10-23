import type postgres from 'postgres';
import { emitEvent } from '../events.js';

// Project membership: one table serves desktop team mode and cloud shares; every mutation is evented.

const ACTOR = 'kernel.members';

export type ProjectRole = 'owner' | 'builder' | 'member';

export interface ProjectMemberRow {
  projectId: string; userId: string; role: ProjectRole; orgId: string; createdAt: string;
}

export async function addProjectMember(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; userId: string; role: ProjectRole; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [proj] = await sql<{ id: string }[]>`
    select id from projects where id = ${input.projectId} and org_id = ${input.orgId} and archived_at is null`;
  if (!proj) return { ok: false, error: 'project not found in this account' };
  const [existing] = await sql<{ role: string }[]>`
    select role from project_members where project_id = ${input.projectId} and user_id = ${input.userId}`;
  if (existing) return { ok: false, error: `already a member (${existing.role}) — change the role instead` };
  await sql`
    insert into project_members (project_id, user_id, role, org_id)
    values (${input.projectId}, ${input.userId}, ${input.role}, ${input.orgId})`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: input.actor || ACTOR, type: 'project.member_added',
    payload: { projectId: input.projectId, userId: input.userId, role: input.role },
  });
  return { ok: true };
}

export async function changeProjectMemberRole(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; userId: string; role: ProjectRole; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql`
    update project_members set role = ${input.role}
    where project_id = ${input.projectId} and user_id = ${input.userId} and org_id = ${input.orgId}
    returning user_id`;
  if (rows.length === 0) return { ok: false, error: 'not a member of this project' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: input.actor || ACTOR, type: 'project.member_role_changed',
    payload: { projectId: input.projectId, userId: input.userId, role: input.role },
  });
  return { ok: true };
}

/** Remove a member; takes effect at the next request. */
export async function removeProjectMember(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; userId: string; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql`
    delete from project_members
    where project_id = ${input.projectId} and user_id = ${input.userId} and org_id = ${input.orgId}
    returning user_id`;
  if (rows.length === 0) return { ok: false, error: 'not a member of this project' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: input.actor || ACTOR, type: 'project.member_removed',
    payload: { projectId: input.projectId, userId: input.userId },
  });
  return { ok: true };
}

export async function listProjectMembers(
  sql: postgres.Sql, input: { orgId: string; projectId: string },
): Promise<ProjectMemberRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select project_id, user_id, role, org_id, created_at from project_members
    where project_id = ${input.projectId} and org_id = ${input.orgId}
    order by created_at asc`;
  return rows.map((r) => ({
    projectId: r['project_id'] as string, userId: r['user_id'] as string,
    role: r['role'] as ProjectRole, orgId: r['org_id'] as string,
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));
}

/** The role a user holds on a project; the account owner implicitly owns every project. */
export async function resolveProjectRole(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; userId: string; accountOwnerUserId: string },
): Promise<ProjectRole | null> {
  if (input.userId === input.accountOwnerUserId) return 'owner';
  const [row] = await sql<{ role: ProjectRole }[]>`
    select role from project_members
    where project_id = ${input.projectId} and user_id = ${input.userId} and org_id = ${input.orgId}`;
  return row?.role ?? null;
}
