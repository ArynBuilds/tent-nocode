import { z } from 'zod';
import { applyUserRevision } from '../scenes/apply.js';
import { submitSceneAction } from '../scenes/actions.js';
import { mintLibraryItem } from '../scenes/library.js';
import { assertOwnOrg, router, write } from './registry.js';

const orgId = z.string();

export const sceneWritesRouter = router({
  sceneAction: write([orgId, z.string(), z.string(), z.record(z.unknown()).optional()], async (ctx, org, sceneSlug, action, values) => {
    assertOwnOrg(ctx.identity, org);
    // The answer carries its effects (and the run it could not await) to the screen.
    return submitSceneAction(ctx.sql, {
      orgId: ctx.identity.orgId, sceneSlug, action, values: values ?? {}, userId: ctx.identity.userId,
    });
  }),

  sceneApplyOps: write([orgId, z.string(), z.array(z.unknown())], async (ctx, org, sceneSlug, ops) => {
    assertOwnOrg(ctx.identity, org);
    return applyUserRevision(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, actor: `user:${ctx.identity.userId}`, ops });
  }),

  createComponentFromNode: write([orgId, z.string(), z.string(), z.string(), z.string().optional()], async (ctx, org, sceneSlug, nodeId, title, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return mintLibraryItem(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: projectId ?? null,
      sceneSlug, nodeId, title, createdBy: ctx.identity.userId,
    });
  }),
});
