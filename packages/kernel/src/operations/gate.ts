import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type postgres from 'postgres';
import { KEBAB_RE } from '@nodeloom/core';
import { emitEvent } from '../events.js';
import { resolveProject } from '../containment.js';
import { createOperation, validateOperationInput } from './registry.js';
import { runOperation } from './dispatch.js';
import type { ActionSpec } from '../chat/actions.js';

// Chat actions for proposing and running operations, validated at the gate.

const operationProposalSchema = z.object({
  name: z.string().regex(KEBAB_RE, 'kebab-case operation name, e.g. segment-volume'),
  code: z.string().min(1),
  runtime: z.enum(['wasm', 'native']),
  ioContract: z.record(z.string(), z.unknown()),
  /** The authoring run where this code proved itself. */
  provenanceRunId: z.string().uuid().optional(),
  /** Model triple: all three fields together or none; the file must hash to the pin. */
  modelPath: z.string().min(1).optional(),
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase sha256 hex').optional(),
  modelLicense: z.string().min(2).max(200).optional(),
}).strict().superRefine((val, ctx) => {
  const deep = validateOperationInput({
    name: val.name, projectId: null, code: val.code, runtime: val.runtime, ioContract: val.ioContract,
  });
  if (!deep.ok) {
    for (const e of deep.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ioContract'], message: e });
  }
  const modelBits = [val.modelPath, val.modelSha256, val.modelLicense].filter((v) => v !== undefined).length;
  if (modelBits > 0 && modelBits < 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelPath'], message: 'a model needs all three: modelPath + modelSha256 + modelLicense (hash-pinned, consent-born)' });
  }
  if (val.modelPath !== undefined) {
    if (!isAbsolute(val.modelPath)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelPath'], message: 'modelPath must be absolute' });
    } else if (!existsSync(val.modelPath)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelPath'], message: `model file not found: ${val.modelPath}` });
    } else if (val.modelSha256 !== undefined) {
      // Verify the pin against the file before the card exists.
      const actual = createHash('sha256').update(readFileSync(val.modelPath)).digest('hex');
      if (actual !== val.modelSha256) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelSha256'], message: `declared sha256 does not match the file (file is ${actual.slice(0, 16)}…)` });
      }
    }
  }
});

export const OPERATION_ACTIONS: Record<string, ActionSpec> = {
  operation_proposal: {
    name: 'operation_proposal',
    escalationKind: 'operation_proposal',
    lands: 'the tool registers as a version in this project after the card',
    route: { kind: 'operation', verb: 'exists' },
    paramsSchema: operationProposalSchema as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql: postgres.Sql, ctx, params): Promise<void> {
      const p = params as z.infer<typeof operationProposalSchema>;
      // Re-verify the model file at execute; it may have drifted since the card.
      if (p.modelPath !== undefined && p.modelSha256 !== undefined) {
        if (!existsSync(p.modelPath)) throw new Error(`model file gone: ${p.modelPath}`);
        const actual = createHash('sha256').update(readFileSync(p.modelPath)).digest('hex');
        if (actual !== p.modelSha256) throw new Error('model file drifted between card and approval — refusing (re-propose with the current hash)');
        const mb = Math.round(statSync(p.modelPath).size / 1e6);
        if (mb > 512) throw new Error(`model exceeds the 512MB v1 ceiling (${mb}MB)`);
      }
      const created = await createOperation(sql, {
        orgId: ctx.orgId,
        // The registered operation lands in the asking thread's project.
        projectId: await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId }),
        name: p.name, code: p.code, runtime: p.runtime,
        ioContract: p.ioContract, provenanceRunId: p.provenanceRunId ?? null,
        createdBy: ctx.resolvedBy ?? ctx.createdBy,
        modelHash: p.modelSha256 ?? null, modelPath: p.modelPath ?? null, modelLicense: p.modelLicense ?? null,
      });
      if (!created.ok) throw new Error(`operation not registered: ${created.errors.join(' · ')}`);
      // The event type renamed with the wording (no reader filtered on the old type; old rows keep it).
      await emitEvent(sql, {
        orgId: ctx.orgId, actor: 'kernel.operations', type: 'operation.registered',
        payload: {
          name: created.name, version: created.version, codeHash: created.codeHash,
          provenanceRunId: p.provenanceRunId ?? null, approvedBy: ctx.resolvedBy ?? ctx.createdBy,
          ...(p.modelSha256 !== undefined ? { modelHash: p.modelSha256, modelLicense: p.modelLicense } : {}),
        },
      });
    },
  },
  run_operation: {
    name: 'run_operation',
    escalationKind: 'run_operation',
    lands: 'the tool runs once through the sealed executor; the record keeps the run',
    route: { kind: 'operation', verb: 'run' },
    paramsSchema: z.object({
      operation: z.string().regex(KEBAB_RE),
      version: z.number().int().min(1).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql: postgres.Sql, ctx, params): Promise<void> {
      const p = params as { operation: string; version?: number; inputs: Record<string, unknown> };
      const res = await runOperation(sql, {
        orgId: ctx.orgId,
        projectId: await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId }),
        operation: p.operation,
        ...(p.version !== undefined ? { version: p.version } : {}),
        inputs: p.inputs ?? {},
        trigger: { kind: 'chat', threadId: ctx.threadId },
        createdBy: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!res.ok) throw new Error(`run_operation refused: ${res.reason}`);
    },
  },
};
