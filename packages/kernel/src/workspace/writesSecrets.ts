import { z } from 'zod';
import { deleteSecretValue, listSecretMeta, setSecretValue } from '../secrets/store.js';
import { read, router, write, type WorkspaceContext } from './registry.js';

// Vault procedures: set, delete, list metadata. No get - values never leave executors.

const requireKey = (ctx: WorkspaceContext): Buffer => {
  if (ctx.deps.vaultMasterKey === null) throw new Error('the vault is not configured on this host - the master key is absent');
  return ctx.deps.vaultMasterKey;
};

export const secretsRouter = router({
  'secrets.set': write([z.object({ name: z.string(), value: z.string(), projectId: z.string().nullable().optional() })], async (ctx, input) => {
    await setSecretValue(ctx.sql, requireKey(ctx), {
      orgId: ctx.identity.orgId, projectId: input.projectId ?? null,
      name: input.name, value: input.value, createdBy: ctx.identity.userId,
    });
    return undefined;
  }),

  'secrets.delete': write([z.object({ name: z.string(), projectId: z.string().nullable().optional() })], async (ctx, input) => {
    await deleteSecretValue(ctx.sql, { orgId: ctx.identity.orgId, projectId: input.projectId ?? null, name: input.name });
    return undefined;
  }),

  'secrets.list': read([], async (ctx) => listSecretMeta(ctx.sql, ctx.identity.orgId)),
});
