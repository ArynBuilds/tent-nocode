import type { ConsentGrantRow, ReactiveChainRow, TriggerWireRow } from '@tent-nocode/core';
import type postgres from 'postgres';
import { z } from 'zod';
import { listConsentGrants, revokeConsentGrant } from '../consent.js';
import { listReactiveChains, revokeReactiveChain } from '../operations/reactive.js';
import { deleteTrigger, listTriggers, setTriggerEnabled } from '../triggers.js';
import { addConnection, revokeConnection } from '../connections.js';
import { assertOwnOrg, read, router, write } from './registry.js';

// Standing consents: reactive chains, triggers, grants, connections.

export async function listReactiveChainsImpl(sql: postgres.Sql, orgId: string): Promise<ReactiveChainRow[]> {
  const rows = await listReactiveChains(sql, orgId);
  return rows.map((r) => ({
    id: r.id, operation: r.operation, inputs: r.inputs, watch: r.watch,
    enabled: r.enabled, grantMode: r.grantMode, revokedAt: r.revokedAt, createdAt: r.createdAt,
  }));
}

export async function revokeReactiveChainImpl(sql: postgres.Sql, orgId: string, chainId: string): Promise<undefined> {
  await revokeReactiveChain(sql, { orgId, chainId });
  return undefined;
}

export async function listTriggersImpl(sql: postgres.Sql, orgId: string): Promise<TriggerWireRow[]> {
  const rows = await listTriggers(sql, orgId);
  return rows.filter((r) => r.revokedAt === null).map((r) => ({
    id: r.id, kind: r.kind, spec: r.spec, action: r.action as unknown as Record<string, unknown>,
    enabled: r.enabled, createdAt: r.createdAt,
    lastFiredAt: r.lastFiredAt, lastFireCount: r.lastFireCount, pausedReason: r.pausedReason,
  }));
}

export async function setTriggerEnabledImpl(sql: postgres.Sql, orgId: string, triggerId: string, enabled: boolean): Promise<undefined> {
  await setTriggerEnabled(sql, { orgId, triggerId, enabled });
  return undefined;
}

export async function deleteTriggerImpl(sql: postgres.Sql, orgId: string, triggerId: string): Promise<undefined> {
  await deleteTrigger(sql, { orgId, triggerId });
  return undefined;
}

/** The ONE grant store, listed for the settings panel. */
export async function listConsentGrantsImpl(sql: postgres.Sql, orgId: string): Promise<ConsentGrantRow[]> {
  const rows = await listConsentGrants(sql, orgId);
  return rows.map((r) => ({
    id: r.id, projectId: r.projectId, class: r.class, subject: r.subject,
    grantedBy: r.grantedBy, grantedAt: r.grantedAt, revokedAt: r.revokedAt,
  }));
}

export async function revokeConsentGrantImpl(sql: postgres.Sql, orgId: string, grantId: string, revokedBy: string): Promise<undefined> {
  await revokeConsentGrant(sql, { orgId, grantId, revokedBy });
  return undefined;
}

const orgId = z.string();
const customConnection = z.object({
  title: z.string(), command: z.array(z.string()), secretName: z.string(), secretEnv: z.string(),
  defaultRules: z.array(z.object({ pattern: z.string(), effect: z.enum(['allow', 'ask']) })),
});

export const standingRouter = router({
  listReactiveChains: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listReactiveChainsImpl(ctx.sql, ctx.identity.orgId);
  }),
  revokeReactiveChain: write([orgId, z.string()], async (ctx, org, chainId) => {
    assertOwnOrg(ctx.identity, org);
    return revokeReactiveChainImpl(ctx.sql, ctx.identity.orgId, chainId);
  }),
  listTriggers: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listTriggersImpl(ctx.sql, ctx.identity.orgId);
  }),
  setTriggerEnabled: write([orgId, z.string(), z.boolean()], async (ctx, org, triggerId, enabled) => {
    assertOwnOrg(ctx.identity, org);
    return setTriggerEnabledImpl(ctx.sql, ctx.identity.orgId, triggerId, enabled);
  }),
  deleteTrigger: write([orgId, z.string()], async (ctx, org, triggerId) => {
    assertOwnOrg(ctx.identity, org);
    return deleteTriggerImpl(ctx.sql, ctx.identity.orgId, triggerId);
  }),
  listConsentGrants: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listConsentGrantsImpl(ctx.sql, ctx.identity.orgId);
  }),
  revokeConsentGrant: write([orgId, z.string()], async (ctx, org, grantId) => {
    assertOwnOrg(ctx.identity, org);
    return revokeConsentGrantImpl(ctx.sql, ctx.identity.orgId, grantId, ctx.identity.userId);
  }),

  // Connection procedures never carry the token; secrets travel their own lane.
  addConnection: write([orgId, z.string(), customConnection.optional()], async (ctx, org, serviceId, custom) => {
    assertOwnOrg(ctx.identity, org);
    return addConnection(ctx.sql, { orgId: ctx.identity.orgId, serviceId, createdBy: ctx.identity.userId, ...(custom ? { custom } : {}) });
  }),
  revokeConnection: write([orgId, z.string()], async (ctx, org, connectionId) => {
    assertOwnOrg(ctx.identity, org);
    await revokeConnection(ctx.sql, { orgId: ctx.identity.orgId, connectionId, revokedBy: ctx.identity.userId });
    return undefined;
  }),
});
