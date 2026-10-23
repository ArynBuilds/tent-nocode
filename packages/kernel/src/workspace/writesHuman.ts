import { z } from 'zod';
import { emitEvent } from '../events.js';
import { getOrgConfig } from '../config.js';
import { deleteDatasetHuman, deleteProjectHuman, deleteSceneHuman, deleteThreadHuman } from '../human/deletion.js';
import {
  appendRowHuman, bindOpOutput, deleteRowById, dispatchOpRun, getArrangement, insertDataset, insertScene,
  mintChain, mintTrigger, projectCanvas, registerOperationVersion, removeBinding, restoreRowById,
  setArrangement, setBinding, setColumnDisplay, setTargetScreen, updateRowById,
} from '../human/doors.js';
import { mapActionRuleParam, removeAction, removeActionRule, setAction, unmapActionRuleParam } from '../human/actionDoors.js';
import { listTrash, restoreCitizenHuman } from '../human/trash.js';
import { queueRowsImportAsUser } from '../scenes/importFile.js';
import { importPackage } from '../scenes/packageImport.js';
import { resolveOperation, retireOperation } from '../operations/registry.js';
import { listSceneActionDocs } from '../scenes/actionDescribe.js';
import { getSubtree } from '../scenes/read.js';
import { getSceneBindings, requireScene } from '../scenes/store.js';
import { evolveDataset } from '../tabs/datasetEvolve.js';
import { renameTab } from '../tabs/model.js';
import { datasetGrain, setDatasetGrain } from '../tabs/datasets.js';
import { datasetBrief, datasetRowsPage } from './readsTabs.js';
import { assertOwnOrg, read, router, write } from './registry.js';

// The human doors: what a hand does on the workspace without the model - citizens, rows, bindings, actions.

const orgId = z.string();
const optProject = z.string().optional();
const record = z.record(z.unknown());
const screenSize = z.object({ w: z.number(), h: z.number() });
const columnType = z.enum(['string', 'number', 'boolean']);

export const humanRouter = router({
  humanImportRows: write([z.object({ projectId: z.string(), fileName: z.string(), stagedPath: z.string(), ext: z.string() })], async (ctx, input) =>
    queueRowsImportAsUser(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: input.projectId, fileName: input.fileName,
      stagedPath: input.stagedPath, ext: input.ext, by: ctx.identity.userId,
    })),

  humanImportPackage: write([z.object({ file: z.unknown(), projectId: z.string().optional(), sourceName: z.string().optional() })], async (ctx, input) => {
    if (input.file === undefined || input.file === null) throw new Error('humanImportPackage needs the parsed package');
    const res = await importPackage(ctx.sql, {
      orgId: ctx.identity.orgId, file: input.file, createdBy: ctx.identity.userId,
      ...(input.projectId !== undefined
        ? { projectId: input.projectId }
        : { findOrBirthProject: true, sourcePath: input.sourceName ?? 'imported package' }),
    });
    if (!res.ok) {
      const first = (res.errors ?? [])[0] ?? 'one entry does not match its hash';
      return { ok: false as const, lane: 'package' as const, sentence: `this file is damaged — ${first}` };
    }
    return {
      ok: true as const, lane: 'package' as const,
      ...(res.alreadyImported === true ? { alreadyImported: true } : {}),
      ...(res.projectName !== undefined ? { projectName: res.projectName } : {}),
      ...(res.projectId !== undefined ? { projectId: res.projectId } : {}),
    };
  }),

  // The code tab's file write lands on this machine's disk in the desktop; the record keeps it.
  humanFileWritten: write([z.object({ path: z.string().min(1), bytes: z.number().int().min(0) })], async (ctx, input) => {
    await emitEvent(ctx.sql, {
      orgId: ctx.identity.orgId, actor: 'user', type: 'human.file_written',
      payload: { path: input.path, bytes: input.bytes, by: ctx.identity.userId },
    });
    return undefined;
  }),

  // A build run's before/after screenshot lands in the record.
  recordSceneEyes: write([z.record(z.unknown())], async (ctx, payload) => {
    await emitEvent(ctx.sql, { orgId: ctx.identity.orgId, actor: 'kernel.scenes.eyes', type: 'scene.eyes', payload });
    return undefined;
  }),

  humanInsertDataset: write([orgId, z.string(), z.record(columnType).optional(), optProject, z.string().optional()], async (ctx, org, name, columns, projectId, displayName) => {
    assertOwnOrg(ctx.identity, org);
    return insertDataset(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: projectId ?? null, name,
      ...(columns !== undefined ? { columns } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      by: ctx.identity.userId,
    });
  }),

  humanInsertScene: write([orgId, z.string(), screenSize.optional(), optProject], async (ctx, org, title, targetScreen, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return insertScene(ctx.sql, {
      orgId: ctx.identity.orgId, title, by: ctx.identity.userId,
      ...(targetScreen !== undefined ? { targetScreen } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    });
  }),

  humanDeleteDataset: write([orgId, z.string(), optProject], async (ctx, org, name, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await deleteDatasetHuman(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, name, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.error);
    return { rows: res.rows };
  }),

  humanDeleteThread: write([orgId, z.string()], async (ctx, org, threadId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await deleteThreadHuman(ctx.sql, { orgId: ctx.identity.orgId, threadId, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.error);
    return undefined;
  }),

  humanDeleteProject: write([orgId, z.string()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await deleteProjectHuman(ctx.sql, { orgId: ctx.identity.orgId, projectId, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.error);
    return { scenes: res.scenes, threads: res.threads };
  }),

  humanDeleteScene: write([orgId, z.string()], async (ctx, org, sceneSlug) => {
    assertOwnOrg(ctx.identity, org);
    const res = await deleteSceneHuman(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.error);
    return undefined;
  }),

  trashList: read([orgId, optProject], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const cfg = await getOrgConfig(ctx.sql, ctx.identity.orgId);
    return listTrash(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, trashDays: cfg.cleanup.trashDays });
  }),

  humanRestore: write([orgId, z.enum(['project', 'thread', 'scene', 'dataset', 'note']), z.string()], async (ctx, org, kind, id) => {
    assertOwnOrg(ctx.identity, org);
    const cfg = await getOrgConfig(ctx.sql, ctx.identity.orgId);
    const res = await restoreCitizenHuman(ctx.sql, { orgId: ctx.identity.orgId, kind, id, by: ctx.identity.userId, trashDays: cfg.cleanup.trashDays });
    if (!res.ok) throw new Error(res.error);
    return undefined;
  }),

  humanRetireOperation: write([orgId, z.string(), optProject], async (ctx, org, name, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await retireOperation(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, name, reason: 'deleted by the user' });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return { retired: res.retired };
  }),

  humanProjectCanvas: write([orgId, z.string()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return projectCanvas(ctx.sql, { orgId: ctx.identity.orgId, projectId, by: ctx.identity.userId });
  }),

  projectArrangement: read([orgId, z.string()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return getArrangement(ctx.sql, { orgId: ctx.identity.orgId, projectId });
  }),

  humanSetArrangement: write([orgId, z.string(), record.optional()], async (ctx, org, projectId, doc) => {
    assertOwnOrg(ctx.identity, org);
    await setArrangement(ctx.sql, { orgId: ctx.identity.orgId, projectId, doc: doc ?? {} });
    return undefined;
  }),

  humanMintTrigger: write([orgId, z.string(), z.unknown(), z.unknown(), optProject], async (ctx, org, kind, spec, action, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await mintTrigger(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, kind, spec, action, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.reason);
    return { triggerId: res.triggerId };
  }),

  humanMintChain: write([orgId, z.string(), record.optional(), optProject], async (ctx, org, operation, inputs, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await mintChain(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, operation, inputs: inputs ?? {}, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.reason);
    return { chainId: res.chainId, watch: res.watch };
  }),

  humanBindOpOutput: write([orgId, z.object({
    operation: z.string(), output: z.string().optional(), dataset: z.string().optional(), key: z.string().optional(), clear: z.boolean().optional(),
  }), optProject], async (ctx, org, bind, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await bindOpOutput(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: projectId ?? null, operation: bind.operation, by: ctx.identity.userId,
      ...(bind.output !== undefined ? { output: bind.output } : {}),
      ...(bind.dataset !== undefined ? { dataset: bind.dataset } : {}),
      ...(bind.key !== undefined ? { key: bind.key } : {}),
      ...(bind.clear !== undefined ? { clear: bind.clear } : {}),
    });
    if (!res.ok) throw new Error(res.reason);
    return { operation: res.operation, version: res.version, output: res.output };
  }),

  humanSetBinding: write([orgId, z.string(), z.unknown()], async (ctx, org, sceneSlug, binding) => {
    assertOwnOrg(ctx.identity, org);
    const res = await setBinding(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, binding, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  humanRunOperation: write([orgId, z.string(), record.optional(), optProject], async (ctx, org, operation, inputs, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await dispatchOpRun(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, operation, inputs: inputs ?? {}, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.reason);
    return { executionId: res.executionId };
  }),

  humanUpdateRow: write([orgId, z.string(), z.string(), record.optional(), optProject], async (ctx, org, dataset, rowId, patch, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await updateRowById(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset, rowId, patch: patch ?? {}, by: ctx.identity.userId });
    if (!res.applied) throw new Error(res.reason);
    return undefined;
  }),

  humanAppendRow: write([orgId, z.string(), record.optional(), optProject], async (ctx, org, dataset, row, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await appendRowHuman(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset, row: row ?? {}, by: ctx.identity.userId });
    if (!res.applied) throw new Error(res.reason);
    return { rowId: res.rowId };
  }),

  humanDeleteRow: write([orgId, z.string(), z.string(), optProject], async (ctx, org, dataset, rowId, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await deleteRowById(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset, rowId, by: ctx.identity.userId });
    if (!res.applied) throw new Error(res.reason);
    return { row: res.row };
  }),

  humanRestoreRow: write([orgId, z.string(), z.string(), record.optional(), optProject], async (ctx, org, dataset, rowId, row, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await restoreRowById(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset, rowId, row: row ?? {}, by: ctx.identity.userId });
    if (!res.applied) throw new Error(res.reason);
    return undefined;
  }),

  humanSetColumnDisplay: write([orgId, z.string(), z.string(), z.string().nullable(), optProject], async (ctx, org, dataset, column, display, projectId) => {
    assertOwnOrg(ctx.identity, org);
    await setColumnDisplay(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset, column, display, by: ctx.identity.userId });
    return undefined;
  }),

  humanEvolveDataset: write([orgId, z.string(), z.object({
    add: z.array(z.object({ col: z.string(), type: columnType })).optional(), deprecate: z.array(z.string()).optional(),
  }).optional(), optProject], async (ctx, org, name, moves, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await evolveDataset(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: projectId ?? null, name,
      ...(moves?.add !== undefined ? { add: moves.add } : {}),
      ...(moves?.deprecate !== undefined ? { deprecate: moves.deprecate } : {}),
    });
    if (!res.ok) throw new Error(res.error);
    return undefined;
  }),

  datasetBrief: read([orgId, z.string(), optProject], async (ctx, org, dataset, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return datasetBrief(ctx.sql, { orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset });
  }),

  datasetRows: read([orgId, z.string(), z.number().optional(), z.number().optional(), optProject], async (ctx, org, dataset, limit, offset, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return datasetRowsPage(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: projectId ?? null, dataset,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
  }),

  operationContract: read([orgId, z.string()], async (ctx, org, name) => {
    assertOwnOrg(ctx.identity, org);
    const op = await resolveOperation(ctx.sql, ctx.identity.orgId, { name });
    if (!op) return null;
    return { name: op.name, version: op.version, inputs: op.ioContract.inputs, outputs: op.ioContract.outputs };
  }),

  operationSource: read([orgId, z.string()], async (ctx, org, name) => {
    assertOwnOrg(ctx.identity, org);
    const op = await resolveOperation(ctx.sql, ctx.identity.orgId, { name });
    if (!op) return null;
    return { name: op.name, version: op.version, runtime: op.runtime, code: op.code, status: op.status };
  }),

  registerOperationVersion: write([orgId, z.string(), z.string(), z.object({
    runtime: z.enum(['wasm', 'native']), ioContract: z.unknown(), displayName: z.string().optional(),
  }).optional(), optProject], async (ctx, org, name, code, draft, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await registerOperationVersion(ctx.sql, {
      orgId: ctx.identity.orgId, projectId: projectId ?? null, name, code, by: ctx.identity.userId,
      ...(draft !== undefined ? { runtime: draft.runtime, ioContract: draft.ioContract } : {}),
      ...(draft?.displayName !== undefined ? { displayName: draft.displayName } : {}),
    });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return { name: res.name, version: res.version };
  }),

  humanSetAction: write([orgId, z.string(), z.unknown()], async (ctx, org, sceneSlug, action) => {
    assertOwnOrg(ctx.identity, org);
    const res = await setAction(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, action, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  humanRemoveAction: write([orgId, z.string(), z.string()], async (ctx, org, sceneSlug, action) => {
    assertOwnOrg(ctx.identity, org);
    const res = await removeAction(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, action, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  humanRemoveActionRule: write([orgId, z.string(), z.string(), z.number()], async (ctx, org, sceneSlug, action, rule) => {
    assertOwnOrg(ctx.identity, org);
    const res = await removeActionRule(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, action, rule, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  humanSetDatasetGrain: write([orgId, z.string(), z.string().nullable(), z.enum(['own', 'shared', 'submitted', 'app'])], async (ctx, org, dataset, projectId, grain) => {
    assertOwnOrg(ctx.identity, org);
    const res = await setDatasetGrain(ctx.sql, { orgId: ctx.identity.orgId, projectId, dataset, grain, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.error);
    return undefined;
  }),

  humanDatasetGrain: read([orgId, z.string(), z.string().nullable()], async (ctx, org, dataset, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return datasetGrain(ctx.sql, { orgId: ctx.identity.orgId, projectId, dataset });
  }),

  humanMapActionRuleParam: write([orgId, z.string(), z.string(), z.number(), z.string(), z.unknown(), z.object({
    ensureParam: z.object({ name: z.string(), type: z.enum(['string', 'number', 'boolean', 'json']), description: z.string() }).optional(),
  }).optional()], async (ctx, org, sceneSlug, action, rule, key, value, extras) => {
    assertOwnOrg(ctx.identity, org);
    const res = await mapActionRuleParam(ctx.sql, {
      orgId: ctx.identity.orgId, sceneSlug, action, rule, key, value,
      ...(extras?.ensureParam !== undefined ? { ensureParam: extras.ensureParam } : {}),
      by: ctx.identity.userId,
    });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  humanUnmapActionRuleParam: write([orgId, z.string(), z.string(), z.number(), z.string()], async (ctx, org, sceneSlug, action, rule, key) => {
    assertOwnOrg(ctx.identity, org);
    const res = await unmapActionRuleParam(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, action, rule, key, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  humanRemoveBinding: write([orgId, z.string(), z.string()], async (ctx, org, sceneSlug, name) => {
    assertOwnOrg(ctx.identity, org);
    const res = await removeBinding(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, name, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  // The screen's rename door (user-ruled): the inspector's title row renames the scene's view tab -
  // the one title every surface reads (the artboard label, the tab word, the map card).
  humanRenameView: write([orgId, z.string(), z.string().trim().min(1).max(120)], async (ctx, org, sceneSlug, title) => {
    assertOwnOrg(ctx.identity, org);
    const scene = await requireScene(ctx.sql, ctx.identity.orgId, sceneSlug);
    const [tab] = await ctx.sql<{ slug: string }[]>`
      select slug from tabs where org_id = ${ctx.identity.orgId} and scene_id = ${scene.id} and status != 'deleted' limit 1`;
    if (!tab) throw new Error(`no view tab found for scene '${sceneSlug}'`);
    await renameTab(ctx.sql, { orgId: ctx.identity.orgId, tabSlug: tab.slug, title });
    return undefined;
  }),

  humanSetTargetScreen: write([orgId, z.string(), screenSize.nullable()], async (ctx, org, sceneSlug, target) => {
    assertOwnOrg(ctx.identity, org);
    await setTargetScreen(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, target, by: ctx.identity.userId });
    return undefined;
  }),

  sceneActions: read([orgId, z.string()], async (ctx, org, sceneSlug) => {
    assertOwnOrg(ctx.identity, org);
    return listSceneActionDocs(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug });
  }),

  sceneBindings: read([orgId, z.string()], async (ctx, org, sceneSlug) => {
    assertOwnOrg(ctx.identity, org);
    return getSceneBindings(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug });
  }),

  sceneTargetScreen: read([orgId, z.string()], async (ctx, org, sceneSlug) => {
    assertOwnOrg(ctx.identity, org);
    const scene = await requireScene(ctx.sql, ctx.identity.orgId, sceneSlug);
    const [row] = await ctx.sql<{ target_screen: { w: number; h: number } | null }[]>`
      select target_screen from scenes where id = ${scene.id}`;
    return row?.target_screen ?? null;
  }),

  sceneSubtree: read([orgId, z.string(), z.string(), z.number().optional()], async (ctx, org, sceneSlug, nodeId, depth) => {
    assertOwnOrg(ctx.identity, org);
    return getSubtree(ctx.sql, { orgId: ctx.identity.orgId, sceneSlug, nodeId, depth: depth ?? 6, maxNodes: 200 });
  }),
});
