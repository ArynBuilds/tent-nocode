// Agent-raised integration verbs as governed actions; the call always cards because an outbound authenticated call always needs a human answer.
import { z } from 'zod';
import type { ActionSpec } from '../chat/actions.js';
import { resolveProject } from '../containment.js';
import { resolveIntegrationDef } from './catalog.js';
import { activateIntegrationConnection, placeIntegrationNode } from './connections.js';
import { runIntegrationCall } from './dispatch.js';

export const INTEGRATION_ACTIONS: Record<string, ActionSpec> = {
  // Places a service node from the 80-service shelf, unconnected - the human connects keys on its card; the model never touches secrets.
  integrations_place: {
    name: 'integrations_place',
    escalationKind: 'integrations_place',
    lands: 'the service node lands unconnected; the human connects keys on its card',
    route: { kind: 'service', verb: 'exists' },
    paramsSchema: z.object({
      service: z.string().min(1).describe('the catalog name of the service - api.services(query) finds it'),
      label: z.string().min(1).max(80).optional().describe('the node label (defaults to the service display name)'),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { service: string; label?: string };
      if (resolveIntegrationDef(p.service) === null) {
        throw new Error(`"${p.service}" is not in the service catalog - api.services('${p.service}') searches the shelf`);
      }
      const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
      if (projectId === null || projectId === undefined) throw new Error('this thread has no project - connections live inside a project');
      const placed = await placeIntegrationNode(sql, {
        orgId: ctx.orgId, projectId, name: p.service, createdBy: ctx.createdBy,
        ...(p.label !== undefined ? { label: p.label } : {}),
      });
      if (!placed.ok) throw new Error(placed.refusal);
    },
  },
  // The secret door (ruling 15): the model NAMES the key it needs; the card collects it into the vault (desk.setSecret, project-scoped) and activates the placed node. The value never rides a payload.
  integrations_connect: {
    name: 'integrations_connect',
    escalationKind: 'integrations_connect',
    lands: "the card collects the service's key into the vault and activates the placed node",
    route: { kind: 'service', verb: 'connect' },
    paramsSchema: z.object({
      connectionId: z.string().uuid().describe('the placed service node (a service line places it)'),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { connectionId: string };
      const res = await activateIntegrationConnection(sql, {
        orgId: ctx.orgId, id: p.connectionId, by: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!res.ok) throw new Error(res.refusal);
    },
  },
  call_integration: {
    name: 'call_integration',
    escalationKind: 'call_integration',
    lands: 'one endpoint fires through the vaulted connection after the card; always waits',
    route: { kind: 'service', verb: 'run' },
    paramsSchema: z.object({
      connectionId: z.string().uuid(),
      endpoint: z.string().min(1),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { connectionId: string; endpoint: string; params?: Record<string, string | number | boolean> };
      const res = await runIntegrationCall(sql, {
        orgId: ctx.orgId,
        connectionId: p.connectionId,
        endpoint: p.endpoint,
        params: p.params ?? {},
        trigger: typeof ctx.runId === 'string' ? { kind: 'run', runId: ctx.runId } : { kind: 'chat', threadId: ctx.threadId },
        createdBy: ctx.createdBy,
      });
      if (!res.ok) throw new Error(`integration call refused: ${res.refusal}`);
    },
  },
};
