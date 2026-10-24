import { basename } from 'node:path';
import type postgres from 'postgres';
import {
  documentToOps, stripImportExt, type LsgEntry, type LsgPackage, type SceneDocument,
} from '@nodeloom/core';
import { canonicalContentHash, datasetEntryRows, validateLsgPackage } from './packageVerify.js';
import { emitEvent } from '../events.js';
import { operationCodeHash } from '../operations/registry.js';
import { createChatProject, projectThemeSchema, setProjectTheme } from '../projects.js';
import { ensureDataset, landDatasetRowsWhole } from '../tabs/datasets.js';
import { validateLibraryItem } from './library.js';
import { landTravelEntries, validateTravelEntries } from './packageFlows.js';
import { supersedeScenes } from './packageSupersede.js';
import { applyRevision } from './apply.js';
import { setSceneContracts } from './actions.js';
import { createScene, createSceneTab } from './store.js';

// THE ONE MERGE (Phase 12, ruling 14): import is one merge of the package's collections over the project
// model (Webstudio's fragment shape) - stage 1 validates everything with zero writes, stage 2 lands in
// dependency order inside one compensation stack, refs rewritten in the same pass, consent as today.
// Nothing executes at import; entries land inert under their exact foreign name@version.

const ACTOR = 'kernel.scenes';
/** Revision actor for import-landed folds; must differ from 'kernel.scenes' or the retry wall swallows the fold. */
const REVISION_ACTOR = 'kernel.import';

/** What a name@version collision with different content does; import never destroys local data. */
export type ImportCollisionMode = 'refuse' | 'skip-existing' | 'copy-rename';

/** The landed record keeps its key names: the releases table and its readers speak them. */
export interface ImportLanded {
  scenes: string[];
  components: string[];
  operations: string[];
  datasetsDeclared: string[];
  notes?: string[];
  flows?: string[];
  triggers?: string[];
  services?: string[];
}

export interface ImportResult {
  ok: boolean;
  errors?: string[];
  alreadyImported?: boolean;
  /** Set whenever the import had or birthed a landing project. */
  projectId?: string;
  projectName?: string;
  landed?: ImportLanded;
  /** Colliding entries left local under 'skip-existing'. */
  skipped?: string[];
  /** Colliding entries landed as copies under 'copy-rename'. */
  renamed?: Array<{ kind: 'component' | 'operation' | 'dataset' | 'flow'; from: string; to: string }>;
  /** Prior-release screens retired from serving under 'supersede'; data untouched. */
  retiredScenes?: string[];
  /** Undoes this import's landings whole; present only on a fresh ok landing. */
  compensate?: () => Promise<void>;
}

export interface PackageIdentity {
  title: string;
  /** Absent means a plain project with no visual kind. */
  kind?: 'app' | 'website';
}

/** Identity chain: manifest app, else the project entry, else the first root screen's title, else the file name. */
export function resolvePackageIdentity(pkg: LsgPackage, sourcePath?: string): PackageIdentity {
  const project = pkg.entries.find((e): e is Extract<LsgEntry, { kind: 'project' }> => e.kind === 'project');
  const screen = pkg.entries.find((e): e is Extract<LsgEntry, { kind: 'screen' }> => e.kind === 'screen' && e.role === 'root')
    ?? pkg.entries.find((e): e is Extract<LsgEntry, { kind: 'screen' }> => e.kind === 'screen');
  const kind = pkg.manifest.app?.kind ?? project?.projectKind ?? (screen !== undefined ? 'app' : undefined);
  const title = pkg.manifest.app?.title
    ?? project?.projectName
    ?? screen?.title
    ?? (sourcePath !== undefined ? stripImportExt(basename(sourcePath)) : undefined)
    ?? 'Imported app';
  return { title, ...(kind !== undefined ? { kind } : {}) };
}

/** Find-or-birth: an exact active-project name match lands into it, else birth; `born` lets the caller compensate. */
export async function findOrBirthProjectForPackage(
  sql: postgres.Sql,
  input: { orgId: string; pkg: LsgPackage; createdBy: string; sourcePath?: string },
): Promise<{ projectId: string; projectName: string; born: boolean }> {
  const identity = resolvePackageIdentity(input.pkg, input.sourcePath);
  const [existing] = await sql<{ id: string; name: string }[]>`
    select id, name from projects
    where org_id = ${input.orgId} and name = ${identity.title} and archived_at is null
    order by created_at asc limit 1`;
  if (existing) return { projectId: existing.id, projectName: existing.name, born: false };
  const { projectId } = await createChatProject(sql, {
    orgId: input.orgId, name: identity.title, createdBy: input.createdBy,
    ...(identity.kind !== undefined ? { kind: identity.kind } : {}),
  });
  return { projectId, projectName: identity.title, born: true };
}

/** Pure: moves a screen's references onto renamed identities at known grammar positions, never a blind string sweep. */
function rewriteScreenRefs(
  s: ScreenToLand,
  maps: { itemRenames: Map<string, string>; tableRenames: Map<string, string>; flowRenames: Map<string, string>; screenRenames: Map<string, string> },
): ScreenToLand {
  const doc: SceneDocument = { ...s.document, nodes: {} };
  for (const [id, node] of Object.entries(s.document.nodes)) {
    const components: Record<string, Record<string, unknown>> = {};
    for (const [ref, payload] of Object.entries(node.components)) {
      let next = payload;
      // An instance names its library item; a goto names a screen.
      if (typeof payload['component'] === 'string' && maps.itemRenames.has(payload['component'])) next = { ...next, component: maps.itemRenames.get(payload['component']) };
      const action = next['action'];
      if (action !== null && typeof action === 'object' && !Array.isArray(action) && typeof (action as Record<string, unknown>)['goto'] === 'string') {
        const to = maps.screenRenames.get((action as Record<string, unknown>)['goto'] as string);
        if (to !== undefined) next = { ...next, action: { ...(action as Record<string, unknown>), goto: to } };
      }
      components[ref] = next;
    }
    const refs = node.refs === undefined ? undefined : Object.fromEntries(Object.entries(node.refs).map(([k, target]) => {
      if (!target.startsWith('scene:')) return [k, target];
      const to = maps.screenRenames.get(target.slice('scene:'.length));
      return [k, to !== undefined ? `scene:${to}` : target];
    }));
    doc.nodes[id] = { ...node, components, ...(refs !== undefined ? { refs } : {}) };
  }
  const bindings = s.bindings?.map((b) => {
    const bb = b as Record<string, unknown>;
    return bb['kind'] === 'query' && typeof bb['table'] === 'string' && maps.tableRenames.has(bb['table']) ? { ...bb, table: maps.tableRenames.get(bb['table']) } : b;
  });
  const actions = s.actions?.map((a) => {
    const aa = a as Record<string, unknown>;
    if (!Array.isArray(aa['rules'])) return a;
    const rules = (aa['rules'] as unknown[]).map((r) => {
      const rr = r as Record<string, unknown>;
      let next = rr;
      if (typeof rr['table'] === 'string' && maps.tableRenames.has(rr['table'])) next = { ...next, table: maps.tableRenames.get(rr['table']) };
      if (rr['rule'] === 'start_flow') {
        const flow = typeof rr['flow'] === 'string' ? rr['flow'] : 'main';
        if (maps.flowRenames.has(flow)) next = { ...next, flow: maps.flowRenames.get(flow) };
      }
      if (rr['rule'] === 'navigate' && typeof rr['scene'] === 'string' && maps.screenRenames.has(rr['scene'])) next = { ...next, scene: maps.screenRenames.get(rr['scene']) };
      return next;
    });
    return { ...aa, rules };
  });
  return { ...s, document: doc, ...(bindings !== undefined ? { bindings } : {}), ...(actions !== undefined ? { actions } : {}) };
}

interface ScreenToLand {
  name: string; title: string; document: SceneDocument; bindings?: unknown[]; actions?: unknown[]; targetScreen?: { w: number; h: number };
}

export async function importPackage(
  sql: postgres.Sql,
  /** projectId lands in that project; findOrBirthProject lands by the package's identity, sourcePath as last-fallback name. */
  input: {
    orgId: string; file: unknown; createdBy: string; onCollision?: ImportCollisionMode;
    projectId?: string; findOrBirthProject?: boolean; sourcePath?: string;
    /** 'supersede' advances or retires screens against priorScenes; default 'sibling'. */
    sceneStrategy?: 'sibling' | 'supersede';
    priorScenes?: string[];
    /** Entries the owner's own prior release landed replace in place on collision. */
    priorComponents?: string[];
    priorOperations?: string[];
  },
): Promise<ImportResult> {
  const onCollision: ImportCollisionMode = input.onCollision ?? 'refuse';
  const validated = validateLsgPackage(input.file);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const pkg = validated.pkg;

  // Idempotence by package hash: re-importing the same file is a visible no-op.
  const [prior] = await sql<{ id: number }[]>`
    select id from events where org_id = ${input.orgId} and type = 'package.imported'
    and payload->>'packageHash' = ${pkg.packageHash} limit 1`;
  if (prior) {
    await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'package.import_skipped', payload: { packageHash: pkg.packageHash, reason: 'already imported' } });
    return { ok: true, alreadyImported: true };
  }

  // A supplied landing project must be the org's own active row; the find half of find-or-birth resolves now so collisions are project-scoped.
  let landingProjectId: string | null = input.projectId ?? null;
  let landingProjectName: string | undefined;
  if (landingProjectId !== null) {
    const [proj] = await sql<{ name: string }[]>`
      select name from projects where id = ${landingProjectId} and org_id = ${input.orgId} and archived_at is null`;
    if (!proj) return { ok: false, errors: [`project not found in this org: ${landingProjectId}`] };
    landingProjectName = proj.name;
  }
  if (landingProjectId === null && input.findOrBirthProject === true) {
    const identity = resolvePackageIdentity(pkg, input.sourcePath);
    const [home] = await sql<{ id: string; name: string }[]>`
      select id, name from projects
      where org_id = ${input.orgId} and name = ${identity.title} and archived_at is null
      order by created_at asc limit 1`;
    if (home) { landingProjectId = home.id; landingProjectName = home.name; }
  }
  const projectAssured = landingProjectId !== null || input.findOrBirthProject === true;
  const inProject = (alias?: string): postgres.PendingQuery<postgres.Row[]> =>
    alias !== undefined ? sql`${sql(alias)}.project_id is not distinct from ${landingProjectId}` : sql`project_id is not distinct from ${landingProjectId}`;

  // ---- STAGE 1: validate everything, write nothing. ----
  const errors: string[] = [];
  const skipped: string[] = [];
  const renamed: Array<{ kind: 'component' | 'operation' | 'dataset' | 'flow'; from: string; to: string }> = [];
  // deterministic per-package suffix so a compensated retry lands the same identities
  const copySuffix = `-${pkg.packageHash.slice(0, 8)}`;
  const itemRenames = new Map<string, string>();
  const tableRenames = new Map<string, string>();
  const priorComponentSet = new Set(input.priorComponents ?? []);
  const priorOperationSet = new Set(input.priorOperations ?? []);

  const itemsToLand: Array<{ name: string; version: number; item: Record<string, unknown> }> = [];
  const itemsToReplace: Array<{ name: string; version: number; item: Record<string, unknown>; prior: unknown }> = [];
  const opsToLand: Array<{ name: string; version: number; code: string; codeHash: string; runtime: string; ioContract: unknown; modelHash: string | null; modelLicense: string | null }> = [];
  const opsToReplace: Array<{ name: string; version: number; code: string; codeHash: string; ioContract: unknown; modelHash: string | null; modelLicense: string | null }> = [];
  const tablesToLand: Array<{ name: string; rowSchema: Record<string, 'string' | 'number' | 'boolean'>; keyColumns?: string[]; grain?: string; rows?: Record<string, unknown>[] }> = [];
  const datasetsDeclared: string[] = [];
  const screensToLand: ScreenToLand[] = [];
  const notesToLand: Array<{ projectName: string; notes: Array<{ body: string; author: string; createdAt: string }> }> = [];
  const servicesToDeclare: Array<{ integration: string; version: number; label: string }> = [];
  let projectEntry: Extract<LsgEntry, { kind: 'project' }> | undefined;

  for (const entry of pkg.entries) {
    if (entry.kind === 'project') {
      projectEntry = entry;
    } else if (entry.kind === 'library-item') {
      const deep = validateLibraryItem(entry.item);
      if (!deep.ok) { errors.push(`library item ${entry.name}: ${deep.errors.join(' · ')}`); continue; }
      const at = entry.name.lastIndexOf('@');
      const name = entry.name.slice(0, at);
      const version = Number(entry.name.slice(at + 1));
      if (at === -1 || !Number.isInteger(version)) { errors.push(`library item ${entry.name}: the name is name@version`); continue; }
      const [existing] = await sql<{ definition: unknown }[]>`
        select definition from component_definitions where org_id = ${input.orgId} and ${inProject()} and name = ${name} and version = ${version}`;
      if (existing) {
        if (canonicalContentHash({ item: entry.item }) === canonicalContentHash({ item: existing.definition })) continue; // already present
        if (priorComponentSet.has(`${name}@${version}`)) { itemsToReplace.push({ name, version, item: entry.item, prior: existing.definition }); continue; }
        if (onCollision === 'skip-existing') { skipped.push(`library item ${entry.name} (local kept)`); continue; }
        if (onCollision === 'copy-rename') {
          const newName = `${name}${copySuffix}`;
          const [copy] = await sql<{ n: string }[]>`
            select count(*) as n from component_definitions where org_id = ${input.orgId} and ${inProject()} and name = ${newName} and version = ${version}`;
          if (Number(copy?.n ?? 0) > 0) { errors.push(`library item ${entry.name}: the renamed copy ${newName}@${version} already exists locally - import never overwrites it`); continue; }
          itemRenames.set(name, newName);
          itemRenames.set(`${name}@${version}`, `${newName}@${version}`);
          renamed.push({ kind: 'component', from: `${name}@${version}`, to: `${newName}@${version}` });
          itemsToLand.push({ name: newName, version, item: { ...entry.item, name: newName } });
          continue;
        }
        errors.push(`library item ${entry.name}: exists locally with different content - rename the local item, re-export theirs under a new name, or import with onCollision 'copy-rename' (lineage never splices)`);
        continue;
      }
      itemsToLand.push({ name, version, item: entry.item });
    } else if (entry.kind === 'operation') {
      const reg = entry.registration as { name?: string; version?: number; runtime?: string; codeHash?: string; ioContract?: unknown; modelHash?: string };
      if (!reg.name || !reg.version || !reg.runtime || !reg.codeHash) { errors.push(`operation ${entry.name}: registration incomplete`); continue; }
      if (operationCodeHash(entry.source) !== reg.codeHash) { errors.push(`operation ${entry.name}: source does not match its recorded codeHash (tampered)`); continue; }
      if (reg.modelHash !== undefined && entry.model?.sha256 !== reg.modelHash) { errors.push(`operation ${entry.name}: its model asset is not recorded beside it`); continue; }
      const [existing] = await sql<{ code_hash: string }[]>`
        select code_hash from operations where org_id = ${input.orgId} and ${inProject()} and name = ${reg.name} and version = ${reg.version}`;
      const modelLicense = entry.model?.license ?? null;
      let landName = reg.name;
      if (existing) {
        if (existing.code_hash === reg.codeHash) continue; // already present
        if (priorOperationSet.has(`${reg.name}@${reg.version}`)) {
          opsToReplace.push({ name: reg.name, version: reg.version, code: entry.source, codeHash: reg.codeHash, ioContract: reg.ioContract ?? {}, modelHash: reg.modelHash ?? null, modelLicense });
          continue;
        }
        if (onCollision === 'skip-existing') { skipped.push(`operation ${entry.name} (local kept)`); continue; }
        if (onCollision === 'copy-rename') {
          const newName = `${reg.name}${copySuffix}`;
          const [copy] = await sql<{ n: string }[]>`
            select count(*) as n from operations where org_id = ${input.orgId} and ${inProject()} and name = ${newName} and version = ${reg.version}`;
          if (Number(copy?.n ?? 0) > 0) { errors.push(`operation ${entry.name}: the renamed copy ${newName}@${reg.version} already exists locally - import never overwrites it`); continue; }
          renamed.push({ kind: 'operation', from: `${reg.name}@${reg.version}`, to: `${newName}@${reg.version}` });
          landName = newName;
        } else {
          errors.push(`operation ${entry.name}: exists locally with different code - the rename path applies (lineage never splices); import with onCollision 'copy-rename' to land it as a renamed copy`);
          continue;
        }
      }
      opsToLand.push({ name: landName, version: reg.version, code: entry.source, codeHash: reg.codeHash, runtime: reg.runtime, ioContract: reg.ioContract ?? {}, modelHash: reg.modelHash ?? null, modelLicense });
    } else if (entry.kind === 'table') {
      datasetsDeclared.push(entry.name);
      const rows = datasetEntryRows(pkg, entry);
      const [existing] = await sql<{ id: string }[]>`
        select id from datasets where org_id = ${input.orgId} and ${inProject()} and name = ${entry.name} and deleted_at is null`;
      let landName = entry.name;
      if (rows !== undefined && rows.length > 0 && existing) {
        // rows land only into an absent or empty table
        const [cnt] = await sql<{ n: string }[]>`select count(*) as n from dataset_rows where dataset_id = ${existing.id}`;
        if (Number(cnt?.n ?? 0) > 0) {
          if (onCollision === 'skip-existing') { skipped.push(`table ${entry.name} (local rows kept; the screens re-bind to them)`); continue; }
          if (onCollision === 'copy-rename') {
            const newName = `${entry.name}${copySuffix}`;
            const [copyRows] = await sql<{ n: string }[]>`
              select count(*) as n from dataset_rows r join datasets d on d.id = r.dataset_id
              where d.org_id = ${input.orgId} and ${inProject('d')} and d.name = ${newName} and d.deleted_at is null`;
            if (Number(copyRows?.n ?? 0) > 0) { errors.push(`table ${entry.name}: the renamed copy ${newName} already holds local rows - import never overwrites it`); continue; }
            tableRenames.set(entry.name, newName);
            renamed.push({ kind: 'dataset', from: entry.name, to: newName });
            landName = newName;
          } else {
            errors.push(`table ${entry.name}: exists locally with rows - importing data would overwrite it; rename or empty it first, or import with onCollision 'copy-rename'`);
            continue;
          }
        }
      }
      // a rowless entry lands its schema only when the project has no such table; existing tables stay untouched
      if ((rows === undefined || rows.length === 0) && existing) continue;
      tablesToLand.push({
        name: landName, rowSchema: entry.rowSchema,
        ...(entry.keyColumns !== undefined ? { keyColumns: entry.keyColumns } : {}),
        ...(entry.grain !== undefined ? { grain: entry.grain } : {}),
        ...(rows !== undefined && rows.length > 0 ? { rows } : {}),
      });
    } else if (entry.kind === 'screen') {
      screensToLand.push({
        name: entry.name, title: entry.title, document: entry.document,
        ...(entry.bindings !== undefined ? { bindings: entry.bindings } : {}),
        ...(entry.actions !== undefined ? { actions: entry.actions } : {}),
        ...(entry.targetScreen !== undefined ? { targetScreen: entry.targetScreen } : {}),
      });
    } else if (entry.kind === 'notes') {
      // notes are idempotent by body hash and never overwrite anything
      notesToLand.push({ projectName: entry.projectName, notes: entry.notes });
    } else if (entry.kind === 'service') {
      servicesToDeclare.push({ integration: entry.integration, version: entry.version, label: entry.label });
    }
  }
  // flow and trigger entries validate in packageFlows.ts
  const travel = await validateTravelEntries(sql, { orgId: input.orgId, projectId: landingProjectId, entries: pkg.entries, onCollision, copySuffix, projectAssured });
  errors.push(...travel.errors); skipped.push(...travel.skipped); renamed.push(...travel.renamed);
  // under 'supersede', a slug held by a live screen outside the prior set refuses before anything lands
  if (input.sceneStrategy === 'supersede') {
    const priorSet = new Set(input.priorScenes ?? []);
    for (const s of screensToLand) {
      if (priorSet.has(s.name)) continue;
      const [clash] = await sql<{ id: string }[]>`select id from scenes where org_id = ${input.orgId} and slug = ${s.name} and status != 'deleted'`;
      if (clash) errors.push(`screen ${s.name}: an app already serves a screen at this address - rename the screen or unpublish the other app (slug collisions refuse; nothing rename-and-dangles)`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // ---- STAGE 2: land in dependency order; compensate on the impossible failure. ----
  const compensations: Array<() => Promise<void>> = [];
  const landed: ImportLanded = { scenes: [], components: [], operations: [], datasetsDeclared, notes: [], flows: [], triggers: [], services: [] };
  const retiredScenes: string[] = [];
  try {
    // the landing home resolves first; a birth on a failed landing compensates with the rest
    let born = false;
    if (landingProjectId === null && input.findOrBirthProject === true) {
      const landing = await findOrBirthProjectForPackage(sql, { orgId: input.orgId, pkg, createdBy: input.createdBy, ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}) });
      landingProjectId = landing.projectId;
      landingProjectName = landing.projectName;
      born = landing.born;
      if (landing.born) {
        const bornId = landing.projectId;
        compensations.push(async () => { await sql`delete from projects where id = ${bornId}`; });
      }
    }
    // The theme lands on a born project, or on a landing project that has none; a themed project keeps its own.
    if (landingProjectId !== null && projectEntry?.theme !== undefined) {
      const theme = projectThemeSchema.safeParse(projectEntry.theme);
      const [cur] = await sql<{ theme: unknown }[]>`select theme from projects where id = ${landingProjectId}`;
      const hasTheme = cur !== undefined && cur.theme !== null && typeof cur.theme === 'object' && Object.keys(cur.theme as Record<string, unknown>).length > 0;
      if (theme.success && (born || !hasTheme)) {
        const priorTheme = cur?.theme ?? null;
        const pid = landingProjectId;
        await setProjectTheme(sql, { orgId: input.orgId, projectId: pid, theme: theme.data, by: input.createdBy });
        compensations.push(async () => { await sql`update projects set theme = ${sql.json(priorTheme as postgres.JSONValue)} where id = ${pid}`; });
      }
    }
    for (const c of itemsToLand) {
      const withOrigin = { ...c.item, importedFrom: pkg.manifest.provenance.org, originalHash: canonicalContentHash({ item: c.item }) };
      await sql`
        insert into component_definitions (org_id, project_id, name, version, definition, status, created_by)
        values (${input.orgId}, ${landingProjectId}, ${c.name}, ${c.version}, ${sql.json(withOrigin as never)}, 'active', ${input.createdBy})`;
      compensations.push(async () => { await sql`delete from component_definitions where org_id = ${input.orgId} and name = ${c.name} and version = ${c.version} and ${inProject()}`; });
      landed.components.push(`${c.name}@${c.version}`);
    }
    for (const c of itemsToReplace) {
      const withOrigin = { ...c.item, importedFrom: pkg.manifest.provenance.org, originalHash: canonicalContentHash({ item: c.item }) };
      const priorDef = c.prior;
      await sql`update component_definitions set definition = ${sql.json(withOrigin as never)} where org_id = ${input.orgId} and ${inProject()} and name = ${c.name} and version = ${c.version}`;
      compensations.push(async () => { await sql`update component_definitions set definition = ${sql.json(priorDef as never)} where org_id = ${input.orgId} and ${inProject()} and name = ${c.name} and version = ${c.version}`; });
      landed.components.push(`${c.name}@${c.version}`);
    }
    for (const o of opsToLand) {
      await sql`
        insert into operations (org_id, project_id, name, version, code, code_hash, runtime, io_contract, created_by, model_hash, model_license)
        values (${input.orgId}, ${landingProjectId}, ${o.name}, ${o.version}, ${o.code}, ${o.codeHash}, ${o.runtime}, ${sql.json(o.ioContract as never)}, ${input.createdBy}, ${o.modelHash}, ${o.modelLicense})`;
      compensations.push(async () => { await sql`delete from operations where org_id = ${input.orgId} and name = ${o.name} and version = ${o.version} and ${inProject()}`; });
      landed.operations.push(`${o.name}@${o.version}`);
    }
    for (const o of opsToReplace) {
      const [priorOp] = await sql<{ code: string; code_hash: string; io_contract: unknown; model_hash: string | null; model_license: string | null }[]>`
        select code, code_hash, io_contract, model_hash, model_license from operations where org_id = ${input.orgId} and ${inProject()} and name = ${o.name} and version = ${o.version}`;
      await sql`
        update operations set code = ${o.code}, code_hash = ${o.codeHash}, io_contract = ${sql.json(o.ioContract as never)}, model_hash = ${o.modelHash}, model_license = ${o.modelLicense}
        where org_id = ${input.orgId} and ${inProject()} and name = ${o.name} and version = ${o.version}`;
      compensations.push(async () => {
        if (!priorOp) return;
        await sql`
          update operations set code = ${priorOp.code}, code_hash = ${priorOp.code_hash}, io_contract = ${sql.json(priorOp.io_contract as never)}, model_hash = ${priorOp.model_hash}, model_license = ${priorOp.model_license}
          where org_id = ${input.orgId} and ${inProject()} and name = ${o.name} and version = ${o.version}`;
      });
      landed.operations.push(`${o.name}@${o.version}`);
    }
    for (const t of tablesToLand) {
      const [pre] = await sql<{ id: string }[]>`
        select id from datasets where org_id = ${input.orgId} and ${inProject()} and name = ${t.name} and deleted_at is null`;
      const { datasetId } = await ensureDataset(sql, {
        orgId: input.orgId, projectId: landingProjectId, name: t.name, rowSchema: t.rowSchema,
        ...(t.keyColumns !== undefined ? { keyColumns: t.keyColumns } : {}),
        ...(t.grain === 'own' || t.grain === 'shared' || t.grain === 'submitted' || t.grain === 'app' ? { userScope: t.grain } : {}),
      });
      // a freshly ensured table must also go on compensation or the born project's undo trips its FK
      if (pre) compensations.push(async () => { if (t.rows !== undefined) await sql`delete from dataset_rows where dataset_id = ${datasetId}`; });
      else compensations.push(async () => { await sql`delete from dataset_rows where dataset_id = ${datasetId}`; await sql`delete from datasets where id = ${datasetId}`; });
      if (t.rows !== undefined) {
        // travelling rows land whole; a rejected row aborts the landing
        const res = await landDatasetRowsWhole(sql, { orgId: input.orgId, datasetId, rows: t.rows });
        if (res.rejected.length) throw new Error(`table ${t.name}: ${res.rejected.length} row(s) failed the row schema - ${res.rejected[0]?.reason}`);
      }
    }
    // Screens: refs follow the renamed identities; sibling landing mints slugs and rewrites the links between the landed screens.
    const maps = { itemRenames, tableRenames, flowRenames: travel.flowRenames, screenRenames: new Map<string, string>() };
    if (input.sceneStrategy === 'supersede') {
      const sup = await supersedeScenes(sql, {
        orgId: input.orgId, projectId: landingProjectId, createdBy: input.createdBy, actor: REVISION_ACTOR,
        scenes: screensToLand.map((s) => rewriteScreenRefs(s, maps)), priorScenes: input.priorScenes ?? [], compensations,
      });
      landed.scenes.push(...sup.landed);
      retiredScenes.push(...sup.retired);
      for (const slug of sup.landed) await sql`update scenes set imported_from = ${pkg.manifest.provenance.org} where org_id = ${input.orgId} and slug = ${slug}`;
    } else {
      // two-pass sibling landing: every row exists before any fold validates, so links between the screens resolve
      const created: Array<{ s: ScreenToLand; sceneId: string; slug: string }> = [];
      for (const s of screensToLand) {
        const { sceneId, slug } = await createScene(sql, { orgId: input.orgId, title: s.title, createdBy: input.createdBy, projectId: landingProjectId });
        await sql`update scenes set imported_from = ${pkg.manifest.provenance.org} where id = ${sceneId}`;
        compensations.push(async () => { await sql`delete from scene_revisions where scene_id = ${sceneId}`; await sql`delete from scenes where id = ${sceneId}`; });
        const { tabId } = await createSceneTab(sql, { orgId: input.orgId, sceneId, sceneSlug: slug, title: s.title, createdBy: input.createdBy, projectId: landingProjectId });
        compensations.push(async () => { await sql`delete from tabs where id = ${tabId}`; });
        if (slug !== s.name) maps.screenRenames.set(s.name, slug);
        created.push({ s, sceneId, slug });
      }
      for (const { s: raw, sceneId, slug } of created) {
        const s = rewriteScreenRefs(raw, maps);
        // The contracts land first (validated against the ground root), so the document's queries resolve at its fold.
        if (s.bindings?.length || s.actions?.length) {
          const contracts = await setSceneContracts(sql, { orgId: input.orgId, sceneSlug: slug, bindings: s.bindings ?? [], actions: s.actions ?? [] });
          if (!contracts.ok) throw new Error(`screen ${raw.name}: contracts refused - ${contracts.errors.join('; ')}`);
        }
        const ops = documentToOps(s.document);
        if (ops.length > 0) {
          const applied = await applyRevision(sql, { orgId: input.orgId, sceneSlug: slug, actor: REVISION_ACTOR, mutationId: 1, ops: ops as never });
          if (!applied.ok) throw new Error(`screen ${raw.name}: the wall refused the document - ${applied.errors.join('; ')}`);
        }
        if (s.targetScreen !== undefined) await sql`update scenes set target_screen = ${sql.json(s.targetScreen as unknown as postgres.JSONValue)} where id = ${sceneId}`;
        landed.scenes.push(slug);
      }
    }
    // flows land through saveFlow; triggers land disabled
    const travelLanded = await landTravelEntries(sql, { orgId: input.orgId, projectId: landingProjectId, createdBy: input.createdBy, flows: travel.flows, triggers: travel.triggers, compensations });
    landed.flows!.push(...travelLanded.flows); landed.triggers!.push(...travelLanded.triggers);
    // notes: append-only, deduped by hash, the project found by name or born
    for (const n of notesToLand) {
      const [proj] = await sql<{ id: string }[]>`
        select id from projects where org_id = ${input.orgId} and name = ${n.projectName} and archived_at is null order by created_at asc limit 1`;
      let projectId = proj?.id ?? (landingProjectName === n.projectName ? landingProjectId ?? undefined : undefined);
      if (projectId === undefined) {
        projectId = (await createChatProject(sql, { orgId: input.orgId, name: n.projectName, createdBy: input.createdBy })).projectId;
        const bornId = projectId;
        compensations.push(async () => { await sql`delete from project_notes where project_id = ${bornId}`; await sql`delete from projects where id = ${bornId}`; });
      }
      const { saveNote } = await import('../notes.js');
      let landedCount = 0;
      for (const note of n.notes) {
        const res = await saveNote(sql, { orgId: input.orgId, projectId, author: note.author, body: note.body });
        if (!res.ok) throw new Error(`notes ${n.projectName}: ${res.error}`);
        if (!res.deduped) {
          landedCount++;
          const noteId = res.noteId;
          compensations.push(async () => { await sql`delete from project_notes where id = ${noteId}`; });
        }
      }
      landed.notes!.push(`${n.projectName} (${landedCount} of ${n.notes.length} new)`);
    }
    // Services and the assistant declare last, as events, so a compensated landing never leaves a phantom.
    if (landingProjectId !== null) {
      for (const s of servicesToDeclare) {
        await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'service.declared', payload: { projectId: landingProjectId, integration: s.integration, version: s.version, label: s.label, imported: true } });
        landed.services!.push(`${s.integration}@${s.version}`);
      }
      if (pkg.manifest.assistant !== undefined) {
        const a = pkg.manifest.assistant;
        await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'assistant.declared', payload: { projectId: landingProjectId, name: a.name, ...(a.description !== undefined ? { description: a.description } : {}) } });
      }
    }
  } catch (err) {
    for (const undo of compensations.reverse()) await undo().catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'package.import_failed', payload: { packageHash: pkg.packageHash, error: message } });
    return { ok: false, errors: [message] };
  }

  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'package.imported',
    payload: {
      packageHash: pkg.packageHash,
      origin: pkg.manifest.provenance, license: pkg.manifest.license,
      closure: pkg.manifest.closure.map((c) => ({ kind: c.kind, name: c.name, role: c.role })),
      landed,
      ...(landingProjectId !== null ? { projectId: landingProjectId } : {}),
      onCollision, skipped, renamed,
      ...(retiredScenes.length ? { retiredScenes } : {}),
    },
  });
  return {
    ok: true, landed,
    ...(landingProjectId !== null ? { projectId: landingProjectId } : {}),
    ...(landingProjectName !== undefined ? { projectName: landingProjectName } : {}),
    ...(skipped.length ? { skipped } : {}), ...(renamed.length ? { renamed } : {}),
    ...(retiredScenes.length ? { retiredScenes } : {}),
    // runs the same undo stack a stage-2 failure runs
    compensate: async () => { for (const undo of compensations.reverse()) await undo().catch(() => undefined); },
  };
}

// ---------------------------------------------------------------------------
// The human lane: the same merge, no consent ceremony, plus a closure summary.
// ---------------------------------------------------------------------------

export interface ClosureSummary {
  license: string;
  origin: string;
  counts: { screens: number; libraryItems: number; operations: number; tables: number; flows: number; notes: number };
  /** Named entries with their role. */
  entries: Array<{ kind: string; name: string; role: string }>;
}

export interface HumanImportResult extends ImportResult {
  summary?: ClosureSummary;
}

/** Reads the closure summary without landing anything. */
export function summarizePackage(file: unknown): { ok: true; summary: ClosureSummary } | { ok: false; errors: string[] } {
  const v = validateLsgPackage(file);
  if (!v.ok) return { ok: false, errors: v.errors };
  const pkg = v.pkg;
  const counts = { screens: 0, libraryItems: 0, operations: 0, tables: 0, flows: 0, notes: 0 };
  for (const e of pkg.entries) {
    if (e.kind === 'screen') counts.screens++;
    else if (e.kind === 'library-item') counts.libraryItems++;
    else if (e.kind === 'operation') counts.operations++;
    else if (e.kind === 'table') counts.tables++;
    else if (e.kind === 'flow') counts.flows++;
    else if (e.kind === 'notes') counts.notes++;
  }
  return {
    ok: true,
    summary: {
      license: pkg.manifest.license,
      origin: pkg.manifest.provenance.org,
      counts,
      entries: pkg.manifest.closure.map((c) => ({ kind: c.kind, name: c.name, role: c.role })),
    },
  };
}

export async function importPackageHuman(
  sql: postgres.Sql,
  input: { orgId: string; file: unknown; userId: string; onCollision?: ImportCollisionMode; projectId?: string },
): Promise<HumanImportResult> {
  const summary = summarizePackage(input.file);
  // lands in the caller's project when given, else find-or-birth by the package's identity
  const res = await importPackage(sql, {
    orgId: input.orgId, file: input.file, createdBy: input.userId,
    ...(input.onCollision !== undefined ? { onCollision: input.onCollision } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : { findOrBirthProject: true }),
  });
  return summary.ok ? { ...res, summary: summary.summary } : res;
}
