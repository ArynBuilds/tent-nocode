import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { packageExtRe } from '@nodeloom/core';
import { z } from 'zod';
import type postgres from 'postgres';
import type { ActionSpec } from '../chat/actions.js';
import { emitEvent } from '../events.js';
import { buildPackageClosure, type ExportIdentity, type ExportSelection, type InlineDatasetReport } from './packageExport.js';
import { importPackage } from './packageImport.js';
import { validateLsgPackage } from './packageVerify.js';

// Consent actions for exporting and importing project packages (tproject@2); the doors keep their names.

// Public extension is .tproject; .lsg stays accepted as a file name so old paths open (the format inside refuses by name).
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,100}\.(lsg|tproject)$/;

const exportParamsSchema = z
  .object({
    scenes: z.array(z.string().min(1)).max(20).optional(),
    components: z.array(z.string().min(1)).max(50).optional(),
    operations: z.array(z.object({ name: z.string().min(1), version: z.number().int().min(1).optional() }).strict()).max(50).optional(),
    inlineDatasets: z.array(z.string().min(1)).max(20).optional(),
    /** Project notes ride only by explicit choice. */
    notesProjects: z.array(z.string().min(1)).max(10).optional(),
    license: z.string().min(1).max(500),
    workspacePath: z.string().min(1),
    fileName: z.string().regex(FILE_RE, 'fileName must be a bare name ending .tproject (no path separators)'),
    /** Kernel-computed fields attached by the raise gate; execute ignores them, and the gate's spread order overrides model-supplied values. */
    closure: z.array(z.string()).optional(),
    inlineData: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!isAbsolute(val.workspacePath)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workspacePath'], message: 'workspacePath must be absolute' });
    if (!(val.scenes?.length || val.components?.length || val.operations?.length)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'name at least one root: a screen, library item, or operation' });
    }
  });

export async function exportPackageToFile(
  sql: postgres.Sql,
  input: { orgId: string; projectId?: string | null; selection: ExportSelection; license: string; destinationDir: string; fileName: string; identity?: ExportIdentity },
): Promise<{ path: string; packageHash: string; closureCount: number; inlineData: InlineDatasetReport[] }> {
  if (!existsSync(input.destinationDir)) throw new Error(`destination folder does not exist: ${input.destinationDir}`);
  const built = await buildPackageClosure(sql, {
    orgId: input.orgId, selection: input.selection, license: input.license,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    provenance: { org: input.orgId, appVersion: process.env['APP_VERSION'] ?? 'dev', exportedAt: new Date().toISOString() },
    ...(input.identity !== undefined ? { identity: input.identity } : {}),
  });
  if (!built.ok) throw new Error(`export refused: ${built.errors.join(' · ')}`);
  const path = join(input.destinationDir, input.fileName);
  writeFileSync(path, JSON.stringify(built.pkg));
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.scenes', type: 'package.exported',
    payload: {
      path, packageHash: built.pkg.packageHash,
      closure: built.pkg.manifest.closure.map((c) => ({ kind: c.kind, name: c.name, role: c.role })),
      // per-table row counts ride the record; replies report from this
      inlineData: built.inlineData,
    },
  });
  return { path, packageHash: built.pkg.packageHash, closureCount: built.pkg.manifest.closure.length, inlineData: built.inlineData };
}

// Import ceiling; the exporter refuses earlier, so this only catches hand-built files.
const IMPORT_MAX_BYTES = 232 * 1024 * 1024;

const importParamsSchema = z
  .object({
    filePath: z.string().min(1),
    /** Collision choice: refuse (default), keep local and land the rest, or land renamed copies; import never destroys local data. */
    onCollision: z.enum(['refuse', 'skip-existing', 'copy-rename']).optional(),
    /** Kernel-computed card fields; declared so strict() accepts the approved payload, execute reads filePath only. */
    packageHash: z.string().optional(),
    license: z.string().optional(),
    origin: z.string().optional(),
    closure: z.array(z.string()).optional(),
    /** Landing project; absent means find-or-birth by the package's identity. */
    projectId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!isAbsolute(val.filePath) || !packageExtRe().test(val.filePath)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filePath'], message: 'filePath must be an absolute path ending .tproject' });
      return;
    }
    if (!existsSync(val.filePath)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filePath'], message: `file not found: ${val.filePath}` });
      return;
    }
    if (statSync(val.filePath).size > IMPORT_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filePath'], message: 'package exceeds the 232MB import ceiling' });
      return;
    }
    // deep validation runs before any consent card renders
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(val.filePath, 'utf8')); } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filePath'], message: 'file is not valid JSON' });
      return;
    }
    const deep = validateLsgPackage(parsed);
    if (!deep.ok) for (const e of deep.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filePath'], message: e });
  });

export const PACKAGE_ACTIONS: Record<string, ActionSpec> = {
  /** Imports a package file; the consent card renders from the validated manifest. */
  import_package: {
    name: 'import_package',
    escalationKind: 'import_package',
    lands: 'the validated package lands whole in this project; local data survives',
    route: { kind: 'package', verb: 'exists' },
    paramsSchema: importParamsSchema as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = importParamsSchema.parse(params);
      const file: unknown = JSON.parse(readFileSync(p.filePath, 'utf8'));
      const res = await importPackage(sql, {
        orgId: ctx.orgId, file, createdBy: ctx.resolvedBy ?? ctx.createdBy,
        ...(p.onCollision !== undefined ? { onCollision: p.onCollision } : {}),
        // land in the rider's project when supplied, else find-or-birth by the package's identity
        ...(p.projectId !== undefined ? { projectId: p.projectId } : { findOrBirthProject: true, sourcePath: p.filePath }),
      });
      if (!res.ok) throw new Error(`package not imported: ${(res.errors ?? []).join(' · ')}`);
    },
  },
  export_package: {
    name: 'export_package',
    escalationKind: 'export_package',
    lands: 'the closure exports as one portable file; grants and secrets never travel',
    route: { kind: 'package', verb: 'exists' },
    paramsSchema: exportParamsSchema as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = exportParamsSchema.parse(params);
      await exportPackageToFile(sql, {
        orgId: ctx.orgId,
        selection: { scenes: p.scenes, components: p.components, operations: p.operations, inlineDatasets: p.inlineDatasets, notesProjects: p.notesProjects },
        license: p.license, destinationDir: p.workspacePath, fileName: p.fileName,
      });
    },
  },
};
