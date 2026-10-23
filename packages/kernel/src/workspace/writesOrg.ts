import type { OrgConfig } from '@tent-nocode/core';
import type postgres from 'postgres';
import { z } from 'zod';
import { setOrgConfig } from '../config.js';
import { revokeConsentGrantBySubject, writeConsentGrant } from '../consent.js';
import { retireOrgComponent } from '../scenes/library.js';
import { assertOwnOrg, router, write } from './registry.js';

export async function updateOrgConfigImpl(
  sql: postgres.Sql, orgId: string, patch: Record<string, unknown>, updatedBy: string,
): Promise<OrgConfig> {
  return setOrgConfig(sql, orgId, patch, { updatedBy });
}

async function assertAgentInOrg(sql: postgres.Sql, orgId: string, agentId: string): Promise<void> {
  const [row] = await sql<{ org_id: string }[]>`select org_id from agents where id = ${agentId}`;
  if (!row || row.org_id !== orgId) throw new Error('agent not found');
}

/** Human doors over the ONE grant store: the scope-wire gesture writes/reverts an impact subject. */
export async function grantImpactImpl(
  sql: postgres.Sql, orgId: string, agentId: string, action: string, grantedBy: string,
): Promise<undefined> {
  await assertAgentInOrg(sql, orgId, agentId);
  await writeConsentGrant(sql, { orgId, subject: `impact:${agentId}:${action}`, grantedBy, class: 'ask-once', projectId: null });
  return undefined;
}

export async function revokeImpactImpl(
  sql: postgres.Sql, orgId: string, agentId: string, action: string, revokedBy: string,
): Promise<undefined> {
  await assertAgentInOrg(sql, orgId, agentId);
  await revokeConsentGrantBySubject(sql, { orgId, subject: `impact:${agentId}:${action}`, revokedBy });
  return undefined;
}

const orgId = z.string();

export const orgWritesRouter = router({
  updateOrgConfig: write([orgId, z.record(z.unknown()).optional()], async (ctx, org, patch) => {
    assertOwnOrg(ctx.identity, org);
    return updateOrgConfigImpl(ctx.sql, ctx.identity.orgId, patch ?? {}, ctx.identity.userId);
  }),
  grantImpact: write([orgId, z.string(), z.string()], async (ctx, org, agentId, action) => {
    assertOwnOrg(ctx.identity, org);
    return grantImpactImpl(ctx.sql, ctx.identity.orgId, agentId, action, ctx.identity.userId);
  }),
  revokeImpact: write([orgId, z.string(), z.string()], async (ctx, org, agentId, action) => {
    assertOwnOrg(ctx.identity, org);
    return revokeImpactImpl(ctx.sql, ctx.identity.orgId, agentId, action, ctx.identity.userId);
  }),
  retireComponent: write([orgId, z.string(), z.string(), z.string().optional()], async (ctx, org, name, reason, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const r = await retireOrgComponent(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, name, reason });
    if (!r.ok) throw new Error(r.errors.join(' · '));
    return undefined;
  }),
});
