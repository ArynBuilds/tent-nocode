import type postgres from 'postgres';
import { z } from 'zod';
import {
  addProjectMember, changeProjectMemberRole, listProjectMembers,
  removeProjectMember, resolveProjectRole,
} from '../rooms/members.js';
import { assertOwnOrg, read, router, write, type WorkspaceIdentity } from './registry.js';


async function canManageMembers(sql: postgres.Sql, identity: WorkspaceIdentity, projectId: string): Promise<boolean> {
  const role = await resolveProjectRole(sql, {
    orgId: identity.orgId, projectId, userId: identity.userId, accountOwnerUserId: identity.userId,
  });
  return role === 'owner' || role === 'builder';
}

async function requireManager(sql: postgres.Sql, identity: WorkspaceIdentity, projectId: string): Promise<void> {
  if (!(await canManageMembers(sql, identity, projectId))) {
    throw new Error('Building this project needs permission from its owner.');
  }
}

const orgId = z.string();
const role = z.enum(['owner', 'builder', 'member']);

export const membersRouter = router({
  listProjectMembers: read([orgId, z.string()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const members = await listProjectMembers(ctx.sql, { orgId: ctx.identity.orgId, projectId });
    return { members };
  }),

  addProjectMember: write([orgId, z.string(), z.string(), role], async (ctx, org, projectId, userId, memberRole) => {
    assertOwnOrg(ctx.identity, org);
    await requireManager(ctx.sql, ctx.identity, projectId);
    return addProjectMember(ctx.sql, { orgId: ctx.identity.orgId, projectId, userId, role: memberRole, actor: `user:${ctx.identity.userId}` });
  }),

  changeProjectMemberRole: write([orgId, z.string(), z.string(), role], async (ctx, org, projectId, userId, memberRole) => {
    assertOwnOrg(ctx.identity, org);
    await requireManager(ctx.sql, ctx.identity, projectId);
    return changeProjectMemberRole(ctx.sql, { orgId: ctx.identity.orgId, projectId, userId, role: memberRole, actor: `user:${ctx.identity.userId}` });
  }),

  removeProjectMember: write([orgId, z.string(), z.string()], async (ctx, org, projectId, userId) => {
    assertOwnOrg(ctx.identity, org);
    await requireManager(ctx.sql, ctx.identity, projectId);
    return removeProjectMember(ctx.sql, { orgId: ctx.identity.orgId, projectId, userId, actor: `user:${ctx.identity.userId}` });
  }),
});
