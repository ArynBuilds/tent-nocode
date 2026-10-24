import type { IntegrationCatalogWire, IntegrationConnectionWire, IntegrationImportWire, WebhookEndpointWire } from '@nodeloom/core';
import { z } from 'zod';
import { assertOwnOrg, read, router, write } from './registry.js';
import { listIntegrationDefs, type IntegrationDef } from '../integrations/catalog.js';
import {
  activateIntegrationConnection, connectIntegration, listIntegrationConnections,
  placeIntegrationNode, revokeIntegrationConnection, updateIntegrationSettings,
  type IntegrationConnectionRow,
} from '../integrations/connections.js';
import { createWebhookEndpoint, listWebhookEndpoints, revokeWebhookEndpoint, WEBHOOK_SCHEMES, WEBHOOK_SCHEME_BY_SERVICE, type WebhookEndpointRow, type WebhookScheme } from '../integrations/webhooks.js';
import { listIntegrationImports, startIntegrationImport, type IntegrationImportRow } from '../integrations/importDoor.js';
import { buildAuthorizeUrl, signOauthState, type OauthClientLookup } from '../integrations/oauth.js';
import { runIntegrationCall } from '../integrations/dispatch.js';
import { getIntegrationConnection } from '../integrations/connections.js';
import { resolveIntegrationDef } from '../integrations/catalog.js';

export interface OauthChannelDeps {
  appTokenSecret: string;
  redirectUri: string;
  clients: OauthClientLookup;
}

const GENERIC_SCHEME_SPEAKERS = new Set(['clickup', 'mailchimp']);

export function webhookSchemeFor(service: string): WebhookScheme | null {
  return WEBHOOK_SCHEME_BY_SERVICE[service]
    ?? (GENERIC_SCHEME_SPEAKERS.has(service) ? 'generic' : null);
}

function catalogWire(def: IntegrationDef): IntegrationCatalogWire {
  return {
    name: def.name,
    version: def.version,
    displayName: def.displayName,
    blurb: def.blurb,
    category: def.category,
    surfaces: def.surfaces,
    availability: def.availability,
    scope: def.scope,
    authKind: def.auth.kind,
    secretName: def.auth.kind === 'none' || def.auth.kind === 'oauth' ? null : def.auth.secretName,
    tokenHelp: def.auth.kind === 'none' ? null : def.auth.tokenHelp,
    ownerPinned: !Array.isArray(def.hosts) && 'ownerPinned' in def.hosts,
    hostTemplate: !Array.isArray(def.hosts) && 'template' in def.hosts ? { template: def.hosts.template, slot: def.hosts.slot } : null,
    hosts: Array.isArray(def.hosts) ? def.hosts : [],
    endpoints: def.endpoints.map((e) => ({
      id: e.id, displayName: e.displayName, class: e.class,
      params: Object.entries(e.params).map(([name, p]) => ({
        name, type: p.type, required: p.required === true,
        ...(p.help !== undefined ? { help: p.help } : {}),
      })),
    })),
    settings: def.settings.map((s) => ({
      id: s.id, label: s.label, kind: s.kind,
      ...(s.choices !== undefined ? { choices: s.choices } : {}),
      ...(s.help !== undefined ? { help: s.help } : {}),
    })),
    importDoor: def.importDoor !== undefined,
    triggers: def.triggers,
    webhookScheme: webhookSchemeFor(def.name),
  };
}

function connectionWire(row: IntegrationConnectionRow): IntegrationConnectionWire {
  return {
    id: row.id,
    integration: row.integration,
    version: row.version,
    label: row.label,
    status: row.status,
    ownerHost: row.owner_host,
    scope: row.scope,
    settings: row.settings,
    insideTables: row.inside?.tables ?? {},
    projectId: row.project_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function endpointWire(row: WebhookEndpointRow): WebhookEndpointWire {
  return {
    id: row.id,
    token: row.token,
    label: row.label,
    scheme: row.scheme,
    projectId: row.project_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function importWire(row: IntegrationImportRow): IntegrationImportWire {
  return {
    id: row.id,
    connectionId: row.connection_id,
    integration: row.integration,
    dataset: row.dataset,
    status: row.status,
    pages: row.pages,
    rowsLanded: row.rows_landed,
    error: row.error,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const enveloped = <T extends { ok: boolean }>(result: T): T => result;

const orgId = z.string();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const integrationsRouter = router({
  integrationsCatalog: read([], async () => listIntegrationDefs().map(catalogWire)),

  integrationsOauthStart: write([orgId, z.string()], async (ctx, org, id) => {
    assertOwnOrg(ctx.identity, org);
    const oauth = ctx.deps.oauth;
    if (oauth === null) return { ok: false as const, refusal: 'this host has no sign-in door for services' };
    const connection = await getIntegrationConnection(ctx.sql, ctx.identity.orgId, id);
    if (!connection || connection.revoked_at) return { ok: false as const, refusal: 'that connection is already gone' };
    const def = resolveIntegrationDef(connection.integration, connection.version);
    if (!def || def.auth.kind !== 'oauth') return { ok: false as const, refusal: 'that connection does not sign in this way' };
    const creds = def.availability === 'upcoming' ? null : oauth.clients(def.auth.clientEnv);
    if (!creds) return { ok: false as const, refusal: `${def.displayName} is upcoming - it connects the moment its approval clears` };
    const state = signOauthState(oauth.appTokenSecret, { connectionId: connection.id, orgId: ctx.identity.orgId });
    const url = buildAuthorizeUrl(def, creds.id, oauth.redirectUri, state);
    if (url === null) return { ok: false as const, refusal: 'the sign-in address did not resolve' };
    return { ok: true as const, url };
  }),

  integrationsTryEndpoint: write([orgId, z.string(), z.string()], async (ctx, org, connectionId, endpoint) => {
    assertOwnOrg(ctx.identity, org);
    return enveloped(await runIntegrationCall(ctx.sql, {
      orgId: ctx.identity.orgId, connectionId, endpoint, params: {},
      trigger: { kind: 'human', by: ctx.identity.userId }, createdBy: ctx.identity.userId,
    }));
  }),

  integrationsExecutionResult: read([orgId, z.string().regex(UUID, 'which call?')], async (ctx, org, id) => {
    assertOwnOrg(ctx.identity, org);
    const [row] = await ctx.sql<{ status: string; result: unknown; error: string | null }[]>`
      select status, result, error from integration_executions
      where org_id = ${ctx.identity.orgId} and id = ${id}`;
    if (!row) return null;
    return { status: row.status, result: row.result, error: row.error };
  }),

  integrationsList: read([orgId, z.string().optional()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const rows = await listIntegrationConnections(ctx.sql, { orgId: ctx.identity.orgId, projectId });
    return rows.map(connectionWire);
  }),

  integrationsPlace: write([orgId, z.object({
    projectId: z.string(), name: z.string(), version: z.number().optional(), label: z.string().optional(),
  })], async (ctx, org, input) => {
    assertOwnOrg(ctx.identity, org);
    const result = await placeIntegrationNode(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: input.projectId, name: input.name,
      version: input.version, label: input.label, createdBy: ctx.identity.userId,
    });
    return result.ok ? { ok: true as const, connection: connectionWire(result.connection) } : enveloped(result);
  }),

  integrationsActivate: write([orgId, z.object({
    id: z.string(), ownerHost: z.string().optional(), hostValue: z.string().optional(),
  })], async (ctx, org, input) => {
    assertOwnOrg(ctx.identity, org);
    const result = await activateIntegrationConnection(ctx.sql, {
      orgId: ctx.identity.orgId, id: input.id, ownerHost: input.ownerHost, hostValue: input.hostValue, by: ctx.identity.userId,
    });
    return result.ok ? { ok: true as const, connection: connectionWire(result.connection) } : enveloped(result);
  }),

  integrationsConnect: write([orgId, z.object({
    projectId: z.string(), name: z.string(), version: z.number().optional(),
    ownerHost: z.string().optional(), hostValue: z.string().optional(), label: z.string().optional(),
  })], async (ctx, org, input) => {
    assertOwnOrg(ctx.identity, org);
    const result = await connectIntegration(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: input.projectId, name: input.name,
      version: input.version, ownerHost: input.ownerHost, hostValue: input.hostValue, label: input.label, createdBy: ctx.identity.userId,
    });
    return result.ok ? { ok: true as const, connection: connectionWire(result.connection) } : enveloped(result);
  }),

  integrationsRevoke: write([orgId, z.string()], async (ctx, org, id) => {
    assertOwnOrg(ctx.identity, org);
    return revokeIntegrationConnection(ctx.sql, { orgId: ctx.identity.orgId, id, by: ctx.identity.userId });
  }),

  integrationsSettings: write([orgId, z.string(), z.record(z.unknown())], async (ctx, org, id, settings) => {
    assertOwnOrg(ctx.identity, org);
    return updateIntegrationSettings(ctx.sql, { orgId: ctx.identity.orgId, id, settings });
  }),

  integrationsWebhooksCreate: write([orgId, z.object({
    projectId: z.string(), label: z.string().optional(), scheme: z.enum(WEBHOOK_SCHEMES).optional(), secret: z.string().optional(),
  })], async (ctx, org, input) => {
    assertOwnOrg(ctx.identity, org);
    const result = await createWebhookEndpoint(ctx.sql, ctx.deps.vaultMasterKey, {
      orgId: ctx.identity.orgId, projectId: input.projectId,
      label: input.label?.trim() || 'Webhook in', createdBy: ctx.identity.userId,
      scheme: input.scheme ?? 'generic', secret: input.secret,
    });
    return result.ok ? { ok: true as const, endpoint: endpointWire(result.endpoint), secret: result.secret } : enveloped(result);
  }),

  integrationsWebhooksList: read([orgId, z.string().optional()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const rows = await listWebhookEndpoints(ctx.sql, { orgId: ctx.identity.orgId, projectId });
    return rows.map(endpointWire);
  }),

  integrationsWebhooksRevoke: write([orgId, z.string()], async (ctx, org, id) => {
    assertOwnOrg(ctx.identity, org);
    return revokeWebhookEndpoint(ctx.sql, { orgId: ctx.identity.orgId, id, by: ctx.identity.userId });
  }),

  integrationsImportStart: write([orgId, z.object({
    connectionId: z.string(), dataset: z.string().optional(), params: z.record(z.unknown()).optional(),
  })], async (ctx, org, input) => {
    assertOwnOrg(ctx.identity, org);
    const params: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
    }
    return startIntegrationImport(ctx.sql, {
      orgId: ctx.identity.orgId, connectionId: input.connectionId,
      ...(input.dataset !== undefined ? { dataset: input.dataset } : {}),
      params, createdBy: ctx.identity.userId,
    });
  }),

  integrationsImportsList: read([orgId, z.string().optional()], async (ctx, org, connectionId) => {
    assertOwnOrg(ctx.identity, org);
    const rows = await listIntegrationImports(ctx.sql, { orgId: ctx.identity.orgId, ...(connectionId !== undefined ? { connectionId } : {}) });
    return rows.map(importWire);
  }),
});
