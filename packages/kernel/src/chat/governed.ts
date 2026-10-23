import { isAbsolute } from 'node:path';
import type postgres from 'postgres';
import { ACTION_REGISTRY } from './actions.js';
import { projectArm } from '../containment.js';
import { consentGate, type GovernedActionResult } from '../consent.js';

// The raise door: schema + deep validation + card riders, then ONE call into the
// consent gate. The approval path (grants, mode auto-answers, inline landing)
// lives in consent.ts now — nothing here decides consent.

export type { GovernedActionResult };

// Mint-preview seam: the host may register a renderer that turns a candidate definition into a PNG path.
export interface MintPreviewInput { orgId: string; definition: Record<string, unknown> }
export type MintPreviewRenderer = (input: MintPreviewInput) => Promise<string | null>;
let mintPreviewRenderer: MintPreviewRenderer | null = null;
export function registerMintPreviewRenderer(renderer: MintPreviewRenderer | null): void {
  mintPreviewRenderer = renderer;
}

export async function raiseGovernedAction(
  sql: postgres.Sql,
  input: {
    orgId: string; threadId: string; runId?: string | null;
    action: string; params: Record<string, unknown>;
  },
): Promise<GovernedActionResult | null> {
  const spec = ACTION_REGISTRY[input.action];
  if (!spec) return null;
  // Schema, cron, and absolute-path validation before anything is raised.
  const parsed = spec.paramsSchema.safeParse(input.params);
  if (!parsed.success) {
    // Every issue rides one refusal (cap 12) so a payload with N mistakes is refused once, not N times.
    const named = parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || 'params'}: ${i.message}`);
    return { status: 'invalid', reason: named.length > 0 ? named.join(' - ') : 'invalid params' };
  }
  const params = parsed.data;
  // Deep-validate a reactive chain before any card exists.
  if (input.action === 'create_reactive_chain') {
    const p = params as { operation: string; inputs?: Record<string, unknown> };
    const { validateReactiveChain } = await import('../operations/reactive.js');
    const { resolveProject } = await import('../containment.js');
    const deep = await validateReactiveChain(sql, {
      orgId: input.orgId,
      projectId: await resolveProject(sql, { orgId: input.orgId, threadId: input.threadId }),
      operation: p.operation, inputs: p.inputs ?? {},
    });
    if (!deep.ok) return { status: 'invalid', reason: deep.reason };
  }
  // Deep-validate a trigger before any card exists.
  if (input.action === 'create_trigger') {
    const p = params as { triggerKind: string; spec: unknown; action: unknown };
    const { validateTrigger } = await import('../triggers.js');
    const { resolveProject } = await import('../containment.js');
    const deep = await validateTrigger(sql, {
      orgId: input.orgId,
      projectId: await resolveProject(sql, { orgId: input.orgId, threadId: input.threadId }),
      kind: p.triggerKind, spec: p.spec, action: p.action,
    });
    if (!deep.ok) return { status: 'invalid', reason: deep.reason };
  }
  // Resolve and validate the integration call target before any card exists.
  if (input.action === 'call_integration') {
    const p = params as { connectionId: string; endpoint: string; params?: Record<string, string | number | boolean> };
    const { resolveCallTarget } = await import('../integrations/dispatch.js');
    const { validateIntegrationParams } = await import('../integrations/executor.js');
    const target = await resolveCallTarget(sql, { orgId: input.orgId, connectionId: p.connectionId, endpoint: p.endpoint });
    if (!target.ok) return { status: 'invalid', reason: target.refusal };
    const verdict = validateIntegrationParams(target.endpoint, p.params ?? {});
    if (!verdict.ok) return { status: 'invalid', reason: verdict.refusal };
  }
  // A scene_revise payload is dialect text: it compiles here (parse + diff + lint), and the
  // compiled ops run the mutation wall's own validation at the door; no invalid batch ever lands.
  if (input.action === 'scene_revise') {
    const p = params as { sceneSlug: string; code: string };
    const { compileSceneDialectAt, isBudgetFinding, DIALECT_FIX_SENTENCE } = await import('../dialect.js');
    const compiled = await compileSceneDialectAt(sql, { orgId: input.orgId, sceneSlug: p.sceneSlug, code: p.code });
    if (!compiled.ok) return { status: 'invalid', reason: [...compiled.errors.slice(0, 5), DIALECT_FIX_SENTENCE].join(' · ') };
    // Bans always block, on a direct raise too: every ban finding this edit introduces refuses (budgets ride the edit door's tracker).
    const bans = compiled.findings.filter((f) => !isBudgetFinding(f.key) && !compiled.preExisting.some((pre) => pre.key === f.key));
    if (bans.length > 0) return { status: 'invalid', reason: [...bans.slice(0, 5).map((f) => f.message), DIALECT_FIX_SENTENCE].join(' · ') };
    if (compiled.ops.length > 0) {
      const { validateRevisionOps } = await import('../scenes/apply.js');
      const deep = await validateRevisionOps(sql, { orgId: input.orgId, sceneSlug: p.sceneSlug, ops: compiled.ops });
      if (!deep.ok) return { status: 'invalid', reason: deep.errors.slice(0, 5).join(' · ') };
    }
  }
  {
    const d = params as { workspacePath?: string | null; path?: string };
    if (typeof d.workspacePath === 'string' && !isAbsolute(d.workspacePath)) {
      return { status: 'invalid', reason: 'workspacePath: must be an absolute path' };
    }
    if (typeof d.path === 'string' && !isAbsolute(d.path)) {
      return { status: 'invalid', reason: 'path: must be an absolute path' };
    }
  }
  // The package file is re-read kernel-side so the consent card shows the validated closure.
  let closureRider: Record<string, unknown> = {};
  if (input.action === 'import_package') {
    const p = params as { filePath: string };
    try {
      const { readFileSync } = await import('node:fs');
      const { validateLsgPackage } = await import('../scenes/packageVerify.js');
      const v = validateLsgPackage(JSON.parse(readFileSync(p.filePath, 'utf8')));
      if (!v.ok) return { status: 'invalid', reason: v.errors[0] ?? 'invalid package file' };
      closureRider = {
        packageHash: v.pkg.packageHash,
        license: v.pkg.manifest.license,
        origin: v.pkg.manifest.provenance.org,
        closure: v.pkg.manifest.closure.map((c) => `${c.kind} ${c.name}${c.role === 'soft' ? ' (soft — re-binds to your data)' : ''}`),
      };
    } catch {
      return { status: 'invalid', reason: 'package file is not readable JSON' };
    }
  }
  // The export closure is computed kernel-side; an undeliverable selection refuses with the dataset named.
  if (input.action === 'export_package') {
    const p = params as {
      scenes?: string[]; components?: string[];
      operations?: Array<{ name: string; version?: number }>;
      inlineDatasets?: string[]; notesProjects?: string[]; license: string;
    };
    const { buildPackageClosure } = await import('../scenes/packageExport.js');
    const { resolveProject } = await import('../containment.js');
    const built = await buildPackageClosure(sql, {
      orgId: input.orgId,
      // The closure walks the asking thread's project.
      projectId: await resolveProject(sql, { orgId: input.orgId, threadId: input.threadId }),
      selection: { scenes: p.scenes, components: p.components, operations: p.operations, inlineDatasets: p.inlineDatasets, notesProjects: p.notesProjects },
      license: p.license,
      provenance: { org: input.orgId, appVersion: process.env['APP_VERSION'] ?? 'dev', exportedAt: new Date().toISOString() },
    });
    if (!built.ok) return { status: 'invalid', reason: built.errors.join(' · ') };
    closureRider = {
      closure: built.pkg.manifest.closure.map((c) => `${c.kind} ${c.name}${c.role === 'soft' ? ' (soft — the importer re-binds)' : ''}`),
      // All rows ride; the card states rows plus weight.
      inlineData: built.inlineData.map((d) => `${d.name}: all ${d.rowsIncluded} rows inline (${d.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(d.bytes / 1024))}KB` : `${(d.bytes / (1024 * 1024)).toFixed(1)}MB`})`),
    };
  }
  // The key card's riders: the service, its vault secret name and help words, and the node's project (the card scopes the secret to it).
  if (input.action === 'integrations_connect') {
    const p = params as { connectionId: string };
    const { getIntegrationConnection } = await import('../integrations/connections.js');
    const { resolveIntegrationDef } = await import('../integrations/catalog.js');
    const conn = await getIntegrationConnection(sql, input.orgId, p.connectionId);
    if (conn === null || conn.revoked_at !== null) return { status: 'invalid', reason: 'no placed service node has that id - place it with a service line first' };
    const def = resolveIntegrationDef(conn.integration, conn.version);
    if (def === null) return { status: 'invalid', reason: `"${conn.integration}" is not in the service catalog` };
    const auth = def.auth as { kind: string; secretName?: string; tokenHelp?: string };
    if (typeof auth.secretName !== 'string') {
      return { status: 'invalid', reason: `${def.displayName} connects through ${auth.kind}, not a key - the human connects it on the node's own card` };
    }
    closureRider = { service: def.name, secretName: auth.secretName, tokenHelp: auth.tokenHelp ?? '', projectId: conn.project_id };
  }
  // A proposal whose name already has an active version says so on the card.
  if (input.action === 'operation_proposal' && typeof params['name'] === 'string') {
    const { resolveProject } = await import('../containment.js');
    const proposalProject = await resolveProject(sql, { orgId: input.orgId, threadId: input.threadId });
    const [hit] = await sql<{ v: number }[]>`
      select max(version) as v from operations
      where org_id = ${input.orgId} and ${projectArm(sql, proposalProject)} and name = ${params['name'] as string} and status = 'active'`;
    if (hit?.v) closureRider = { ...closureRider, existingNote: `an active ${params['name']}@${hit.v} exists — approving creates @${hit.v + 1}` };
  }
  if (input.action === 'component_proposal') {
    const def = (params['definition'] ?? {}) as { name?: unknown; title?: unknown };
    const defName = typeof def.name === 'string' ? def.name : null;
    // Every wall below checks the asking thread's project, never the whole org.
    const { resolveProject } = await import('../containment.js');
    const proposalProject = await resolveProject(sql, { orgId: input.orgId, threadId: input.threadId });
    // A face's title must be unique in the project's active library.
    if (defName !== null && typeof def.title === 'string') {
      const [clash] = await sql<{ name: string }[]>`
        select name from component_definitions
        where org_id = ${input.orgId} and ${projectArm(sql, proposalProject)} and status = 'active'
          and lower(definition->>'title') = lower(${def.title}) and name != ${defName}
        limit 1`;
      if (clash) {
        return { status: 'invalid', reason: `the display word '${def.title}' already names ${clash.name} in this project — a face's title must be unique so humans can tell them apart; pick another word` };
      }
    }
    if (defName !== null) {
      const [hit] = await sql<{ v: number }[]>`
        select max(version) as v from component_definitions
        where org_id = ${input.orgId} and ${projectArm(sql, proposalProject)} and name = ${defName} and status = 'active'`;
      if (hit?.v) closureRider = { ...closureRider, existingNote: `an active ${defName}@${hit.v} exists — approving creates @${hit.v + 1}` };
    }
    // Non-blocking mint-door observations ride the card.
    {
      const { validateOrgDefinition } = await import('../scenes/library.js');
      const deep = validateOrgDefinition(params['definition']);
      if (deep.ok && deep.notes.length > 0) closureRider = { ...closureRider, mintNotes: deep.notes };
    }
    // Render a preview when a renderer is registered; failures never block the card.
    if (mintPreviewRenderer !== null) {
      try {
        const previewPath = await mintPreviewRenderer({ orgId: input.orgId, definition: params['definition'] as Record<string, unknown> });
        if (previewPath !== null) closureRider = { ...closureRider, previewPath };
      } catch (err) {
        console.error('mint preview skipped:', err instanceof Error ? err.message : String(err));
      }
    }
  }
  return consentGate(sql, {
    orgId: input.orgId, threadId: input.threadId, runId: input.runId ?? null,
    spec, params, riders: closureRider,
  });
}
