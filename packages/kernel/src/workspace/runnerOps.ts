import { datasetQuerySchema } from '@nodeloom/core';
import { z } from 'zod';
import { claimNextExecution, settleExecution } from '../operations/dispatch.js';
import { resolveOperation } from '../operations/registry.js';
import { confirmDerivedOutputs, registerDerivedOutput, resolveDerivedOutput } from '../scenes/derivedOutputs.js';
import { queryDatasetRows } from '../tabs/datasetQuery.js';
import { landRowsOutput } from '../tabs/datasets.js';
import { countDatasetRows, listFolderGrantPaths, readDatasetRowsPage } from '../runnerVerbs.js';
import { read, router, write } from './registry.js';

// The heavy-operation muscle's lane: claim/materialize/land/settle under runner.* names; org-scoped by identity.

const projectId = z.string().nullable().optional();

export const runnerOpsRouter = router({
  'runner.claimNextExecution': write([], async (ctx) => claimNextExecution(ctx.sql, { orgId: ctx.identity.orgId })),

  'runner.settleExecution': write([z.object({
    executionId: z.string(), ok: z.boolean(), error: z.string().optional(), outputs: z.record(z.string()).optional(),
  })], async (ctx, input) => settleExecution(ctx.sql, {
    orgId: ctx.identity.orgId, executionId: input.executionId, ok: input.ok,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.outputs !== undefined ? { outputs: input.outputs } : {}),
  })),

  'runner.resolveOperation': read([z.object({ name: z.string(), version: z.number().optional() }), projectId], async (ctx, ref, project) =>
    resolveOperation(ctx.sql, ctx.identity.orgId,
      { name: ref.name, ...(ref.version !== undefined ? { version: ref.version } : {}) }, project ?? null)),

  'runner.queryDatasetRows': read([z.object({
    projectId, dataset: z.string(), query: datasetQuerySchema.optional(),
  })], async (ctx, input) => queryDatasetRows(ctx.sql, {
    orgId: ctx.identity.orgId, projectId: input.projectId ?? null, dataset: input.dataset,
    ...(input.query !== undefined ? { query: input.query } : {}),
  })),

  'runner.countDatasetRows': read([projectId, z.string()], async (ctx, project, dataset) =>
    countDatasetRows(ctx.sql, ctx.identity.orgId, project ?? null, dataset)),

  'runner.readDatasetRowsPage': read(
    [projectId, z.string(), z.object({ ca: z.string(), id: z.string() }).nullable().optional(), z.number().optional()],
    async (ctx, project, dataset, cursor, pageSize) =>
      readDatasetRowsPage(ctx.sql, ctx.identity.orgId, project ?? null, dataset, cursor ?? null, pageSize ?? 20_000),
  ),

  'runner.resolveDerivedOutput': read([z.object({ projectId, name: z.string() })], async (ctx, input) =>
    resolveDerivedOutput(ctx.sql, { orgId: ctx.identity.orgId, projectId: input.projectId ?? null, name: input.name })),

  'runner.registerDerivedOutput': write([z.object({
    projectId: z.string().nullable(), runId: z.string(), name: z.string(), kind: z.enum(['array', 'raster']),
    path: z.string(), descriptor: z.unknown(), allowedRoots: z.array(z.string()).optional(),
  })], async (ctx, input) => registerDerivedOutput(ctx.sql, { ...input, descriptor: input.descriptor, orgId: ctx.identity.orgId })),

  'runner.landRowsOutput': write([z.object({
    projectId: z.string().nullable(), executionId: z.string(), operation: z.string(),
    dataset: z.string(), key: z.string().optional(), columns: z.record(z.unknown()), rows: z.array(z.unknown()),
  })], async (ctx, input) => landRowsOutput(ctx.sql, { ...input, orgId: ctx.identity.orgId })),

  'runner.confirmDerivedOutputs': write([z.object({ runId: z.string(), runSucceeded: z.boolean() })], async (ctx, input) =>
    confirmDerivedOutputs(ctx.sql, { orgId: ctx.identity.orgId, runId: input.runId, runSucceeded: input.runSucceeded })),

  'runner.listFolderGrantPaths': read([], async (ctx) => listFolderGrantPaths(ctx.sql, ctx.identity.orgId)),
});
