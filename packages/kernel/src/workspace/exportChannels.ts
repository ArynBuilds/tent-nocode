import type postgres from 'postgres';
import { z } from 'zod';
import { buildPackageClosure, closurePreview } from '../scenes/packageExport.js';
import { readNotes } from '../notes.js';
import { projectAssistantName } from '../observatory.js';
import { assertOwnOrg, read, router } from './registry.js';
import type { ExportIdentity } from '../scenes/packageExport.js';

/**
 * THE EXPORT PROCEDURES (the assembly-beside-the-data move): the package
 * ASSEMBLY reads workspace data, so the closure walk runs in the host and the
 * finished package rides the wire back; the desktop keeps only the save dialog
 * and the file write. The publish twin (assembly + the standing publish door)
 * is the /workspace/publishWebsite route (routes.ts - it needs the bearer).
 */

export async function exportIdentityFor(
  sql: postgres.Sql, orgId: string, projectId: string | undefined,
): Promise<ExportIdentity | undefined> {
  if (projectId === undefined) return undefined;
  const [proj] = await sql<{ name: string; kind: 'app' | 'website' | null }[]>`
    select name, kind from projects where id = ${projectId} and org_id = ${orgId} and archived_at is null`;
  if (!proj) return undefined;
  const assistantName = await projectAssistantName(sql, orgId, projectId);
  return {
    app: { title: proj.name, ...(proj.kind !== null ? { kind: proj.kind } : {}) },
    ...(assistantName !== null ? { assistant: { name: assistantName } } : {}),
  };
}

export const exportsRouter = router({
  exportPreview: read([z.string(), z.object({ sceneSlugs: z.array(z.string()), projectId: z.string().optional() })], async (ctx, org, input) => {
    assertOwnOrg(ctx.identity, org);
    // Containment: the walk is project-scoped - a null project resolves org-wide
    // and can preview ANOTHER project's same-named citizens.
    const pre = await closurePreview(ctx.sql, {
      orgId: ctx.identity.orgId, sceneSlugs: input.sceneSlugs,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    });
    if (!pre.ok) throw new Error(pre.errors.join(' · '));
    let notesCount = 0;
    if (input.projectId !== undefined) {
      notesCount = (await readNotes(ctx.sql, { orgId: ctx.identity.orgId, projectId: input.projectId, limit: 200 })).length;
    }
    return { entries: pre.entries, notesCount };
  }),

  // Returns the WHOLE built package - the desktop writes the .tproject bytes
  // where the user's save dialog pointed. Big inline datasets meet the door's
  // named size cap, never a silent slice.
  exportPackage: read([z.object({
    sceneSlugs: z.array(z.string()), inlineDatasets: z.array(z.string()).optional(), notesProjects: z.array(z.string()).optional(),
    license: z.string().optional(), projectId: z.string().optional(), appVersion: z.string().optional(),
  })], async (ctx, input) => {
    const identityRider = await exportIdentityFor(ctx.sql, ctx.identity.orgId, input.projectId);
    const built = await buildPackageClosure(ctx.sql, {
      orgId: ctx.identity.orgId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      selection: {
        scenes: input.sceneSlugs,
        ...(input.inlineDatasets !== undefined && input.inlineDatasets.length > 0 ? { inlineDatasets: input.inlineDatasets } : {}),
        ...(input.notesProjects !== undefined && input.notesProjects.length > 0 ? { notesProjects: input.notesProjects } : {}),
      },
      license: input.license ?? 'All rights reserved',
      provenance: { org: ctx.identity.orgId, appVersion: input.appVersion ?? 'desktop', exportedAt: new Date().toISOString() },
      ...(identityRider !== undefined ? { identity: identityRider } : {}),
    });
    if (!built.ok) throw new Error(`export refused: ${built.errors.join(' · ')}`);
    // The project's canvas arrangement rides as the optional field (beside the manifest, outside the hash).
    let arrangement: Record<string, unknown> | undefined;
    if (input.projectId !== undefined) {
      const [row] = await ctx.sql<{ doc: Record<string, unknown> }[]>`
        select doc from workspace_arrangements
        where org_id = ${ctx.identity.orgId} and project_id = ${input.projectId}`;
      if (row !== undefined && Object.keys(row.doc).length > 0) arrangement = row.doc;
    }
    const pkg = arrangement !== undefined ? { ...built.pkg, arrangement } : built.pkg;
    return { pkg, packageHash: built.pkg.packageHash };
  }),
});
