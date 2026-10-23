import { z } from 'zod';
import type postgres from 'postgres';
import { createTrigger, deleteTrigger } from './triggers.js';
import { TRIGGER_SPECS } from './triggerSpecs.js';
import type { ActionSpec } from './chat/actions.js';

// The kind enum derives from the registry - a new spec row is askable with zero edits here.
const TRIGGER_KINDS = Object.keys(TRIGGER_SPECS) as [keyof typeof TRIGGER_SPECS, ...Array<keyof typeof TRIGGER_SPECS>];

// Governed actions for creating and deleting triggers; deep validation runs at the raise gate.
export const TRIGGER_GOVERNED_ACTIONS: Record<string, ActionSpec> = {
  create_trigger: {
    name: 'create_trigger',
    escalationKind: 'create_trigger',
    lands: 'the trigger stands and fires mechanically with zero AI; editing is a re-mint',
    route: { kind: 'trigger', verb: 'exists' },
    // Named `triggerKind`, not `kind`: the escalation envelope's own `kind` would overwrite it.
    paramsSchema: z.object({
      triggerKind: z.enum(TRIGGER_KINDS),
      spec: z.record(z.string(), z.unknown()),
      action: z.record(z.string(), z.unknown()),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql: postgres.Sql, ctx, params): Promise<void> {
      const p = params as { triggerKind: string; spec: unknown; action: unknown };
      const { resolveProject } = await import('./containment.js');
      const created = await createTrigger(sql, {
        orgId: ctx.orgId,
        // The trigger lives in the asking thread's project.
        projectId: await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId }),
        kind: p.triggerKind, spec: p.spec, action: p.action, createdBy: ctx.createdBy,
      });
      if (!created.ok) throw new Error(`trigger refused: ${created.reason}`);
    },
  },
  /** Delete by quoting words from the trigger's own condition; exactly one match, zero or ambiguous refuse. */
  delete_trigger: {
    name: 'delete_trigger',
    escalationKind: 'delete_trigger',
    lands: 'exactly one trigger matching the quoted spec words is deleted',
    route: { kind: 'trigger', verb: 'exists' },
    paramsSchema: z.object({
      specContains: z.string().min(3),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql: postgres.Sql, ctx, params): Promise<void> {
      const p = params as { specContains: string };
      const matches = await sql<{ id: string }[]>`
        select id from triggers
        where org_id = ${ctx.orgId} and revoked_at is null and spec::text ilike ${'%' + p.specContains + '%'}`;
      if (matches.length === 0) throw new Error(`delete_trigger: no trigger matches '${p.specContains}'`);
      if (matches.length > 1) throw new Error(`delete_trigger: '${p.specContains}' matches ${matches.length} triggers — be more specific`);
      await deleteTrigger(sql, { orgId: ctx.orgId, triggerId: matches[0]!.id });
    },
  },
};
