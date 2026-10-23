import type { OpsKernelPort } from '@tent-nocode/runner';
import { workspaceCall } from './workspaceClient.js';

// OpsKernelPort over the workspace door: each verb rides one runner.* channel.
// The org is never sent; orgId parameters are accepted and dropped.

type Ret<K extends keyof OpsKernelPort> = Awaited<ReturnType<OpsKernelPort[K]>>;

export function createWorkspaceOpsPort(
  call: (channel: string, args: unknown[]) => Promise<unknown> = workspaceCall,
): OpsKernelPort {
  return {
    claimNextExecution: async () =>
      await call('runner.claimNextExecution', []) as Ret<'claimNextExecution'>,

    settleExecution: async (input) => {
      const { orgId: _dropped, ...rest } = input;
      await call('runner.settleExecution', [rest]);
    },

    resolveOperation: async (_orgId, ref, projectId = null) =>
      await call('runner.resolveOperation', [ref, projectId]) as Ret<'resolveOperation'>,

    queryDatasetRows: async (input) => {
      const { orgId: _dropped, ...rest } = input;
      return await call('runner.queryDatasetRows', [rest]) as Ret<'queryDatasetRows'>;
    },

    countDatasetRows: async (_orgId, projectId, dataset) =>
      await call('runner.countDatasetRows', [projectId, dataset]) as Ret<'countDatasetRows'>,

    readDatasetRowsPage: async (_orgId, projectId, dataset, cursor, pageSize) =>
      await call('runner.readDatasetRowsPage', [projectId, dataset, cursor, pageSize]) as Ret<'readDatasetRowsPage'>,

    resolveDerivedOutput: async (input) => {
      const { orgId: _dropped, ...rest } = input;
      const hit = await call('runner.resolveDerivedOutput', [rest]) as
        | (Omit<NonNullable<Ret<'resolveDerivedOutput'>>, 'staleAt'> & { staleAt: string | null })
        | null;
      if (hit === null) return null;
      // Dates die on the JSON wire — staleAt revives here.
      return { ...hit, staleAt: hit.staleAt === null ? null : new Date(hit.staleAt) };
    },

    registerDerivedOutput: async (input) => {
      const { orgId: _dropped, ...rest } = input;
      return await call('runner.registerDerivedOutput', [rest]) as Ret<'registerDerivedOutput'>;
    },

    landRowsOutput: async (input) => {
      const { orgId: _dropped, ...rest } = input;
      return await call('runner.landRowsOutput', [rest]) as Ret<'landRowsOutput'>;
    },

    confirmDerivedOutputs: async (input) => {
      const { orgId: _dropped, ...rest } = input;
      return await call('runner.confirmDerivedOutputs', [rest]) as Ret<'confirmDerivedOutputs'>;
    },

    listFolderGrantPaths: async () =>
      await call('runner.listFolderGrantPaths', []) as Ret<'listFolderGrantPaths'>,
  };
}
