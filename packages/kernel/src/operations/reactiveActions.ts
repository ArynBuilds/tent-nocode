import { z } from 'zod';
import type postgres from 'postgres';
import { KEBAB_RE } from '@tent-nocode/core';
import { createReactiveChain, revokeReactiveChain } from './reactive.js';
import type { ActionSpec } from '../chat/actions.js';

// Chat actions to create and revoke reactive chains; deep validation runs at the raise gate.
export const REACTIVE_ACTIONS: Record<string, ActionSpec> = {
  create_reactive_chain: {
    name: 'create_reactive_chain',
    escalationKind: 'create_reactive_chain',
    lands: 'a standing zero-model grant re-runs the operation when its watched outputs re-register',
    route: { kind: 'chain', verb: 'exists' },
    paramsSchema: z.object({
      operation: z.string().regex(KEBAB_RE, 'kebab-case operation name'),
      /** The runOperation input template; output-typed values become the watch-set. */
      inputs: z.record(z.string(), z.unknown()).default({}),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql: postgres.Sql, ctx, params): Promise<void> {
      const p = params as { operation: string; inputs: Record<string, unknown> };
      const { resolveProject } = await import('../containment.js');
      const created = await createReactiveChain(sql, {
        orgId: ctx.orgId,
        // The chain lives in the asking thread's project.
        projectId: await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId }),
        operation: p.operation, inputs: p.inputs ?? {},
        createdBy: ctx.createdBy,
        grantMode: ctx.resolvedBy === 'mode:auto' ? 'auto' : 'ask-approved',
      });
      if (!created.ok) throw new Error(`reactive chain refused: ${created.reason}`);
    },
  },
  /** Revoke by operation name; zero and ambiguous matches both refuse. */
  revoke_reactive_chain: {
    name: 'revoke_reactive_chain',
    escalationKind: 'revoke_reactive_chain',
    lands: 'exactly one matching chain is revoked; ambiguity refuses',
    route: { kind: 'chain', verb: 'exists' },
    paramsSchema: z.object({
      operation: z.string().regex(KEBAB_RE, 'kebab-case operation name'),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql: postgres.Sql, ctx, params): Promise<void> {
      const p = params as { operation: string };
      const matches = await sql<{ id: string }[]>`
        select id from reactive_chains
        where org_id = ${ctx.orgId} and operation = ${p.operation} and revoked_at is null`;
      if (matches.length === 0) throw new Error(`revoke_reactive_chain: no live chain runs '${p.operation}'`);
      if (matches.length > 1) throw new Error(`revoke_reactive_chain: ${matches.length} chains run '${p.operation}' — revoke the exact one from Settings`);
      await revokeReactiveChain(sql, { orgId: ctx.orgId, chainId: matches[0]!.id });
    },
  },
};
