import type postgres from 'postgres';
import { expandInstanceNodes, instanceRefsIn, projectionRequestSchema, sceneBindingsSchema, type AssetBinding, type SceneBindingFeed } from '@tent-nocode/core';
import { getSceneForHost } from './store.js';
import { stampIconGlyphs } from './icons.js';
import { libraryItemsFor } from './validate.js';
import { executeSceneBinding } from './bindings.js';
import { resolveBindingSource, resolveDerivedOutput } from './derivedOutputs.js';
import { readProjection } from './arrayStore.js';
import { resolveMediaFiles } from '../tabs/media.js';

// The serve lanes over the one binding grammar, shared by the desktop's workspace reads and the hosts'
// data routes: the served document is the instance-expanded tree; every binding runs through the one
// executor; asset rows gain URLs here through the host-injected minter so absolute paths never leave
// the host process.

/** Host-injected media mount minting: one call per mount key; returns one URL per path, index-aligned; re-minting a key replaces the mount. */
export type MediaUrlMinter = (mountKey: string, absPaths: string[]) => string[];

export type ServeBindingFeed = SceneBindingFeed;

export interface ServeSceneData {
  scene: { id: string; slug: string; title: string; status: string; headRevision: number };
  document: unknown;
  results: ServeBindingFeed[];
  /** The design size the document was authored at; the engine's reflow reads its width. */
  targetScreen: { w: number; h: number } | null;
}

export interface ServeSceneProjection {
  binding: string;
  dtype: 'float32' | 'float64' | 'int16' | 'int32' | 'uint8' | 'uint16' | null;
  shape: number[];
  data: ArrayBuffer | null;
  error: string | null;
}

/** Stamps `stale` on output-sourced asset rows; staleness is a courtesy flag and never fails the feed. */
async function stampStale(sql: postgres.Sql, orgId: string, projectId: string | null, b: AssetBinding, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (b.asset === 'media' || b.source.from !== 'output') return rows;
  try {
    const hit = await resolveDerivedOutput(sql, { orgId, projectId, name: b.source.output });
    return rows.map((row) => ({ ...row, stale: hit?.staleAt != null }));
  } catch {
    return rows;
  }
}

async function runOne(
  sql: postgres.Sql, orgId: string, projectId: string | null, binding: Parameters<typeof executeSceneBinding>[2], rowKey: string | undefined,
): Promise<ServeBindingFeed> {
  try {
    const r = await executeSceneBinding(sql, orgId, binding, projectId, { rowKey });
    const rows = binding.kind === 'asset' ? await stampStale(sql, orgId, projectId, binding, r.rows) : r.rows;
    return { binding: r.binding, kind: r.kind, rows, text: r.text, error: null, ...(r.tick !== undefined ? { tick: r.tick } : {}) };
  } catch (err) {
    return { binding: binding.name, kind: binding.kind, rows: [], text: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Media and raster rows gain URLs under one mount key per scene and asset; re-feeding replaces the mount. */
async function mintAssetUrls(
  sql: postgres.Sql, orgId: string, projectId: string | null, sceneId: string,
  bindings: AssetBinding[], results: ServeBindingFeed[], mintMediaUrls: MediaUrlMinter,
): Promise<void> {
  const media = bindings.filter((b) => b.asset === 'media' && b.source.from === 'folder');
  if (media.length > 0) {
    const paths: string[] = [];
    const urlIndexByFile = new Map<string, number>();
    for (const decl of media) {
      if (decl.source.from !== 'folder') continue;
      const { files } = await resolveMediaFiles(sql, { orgId, folder: decl.source.folder, select: decl.source.select });
      for (const f of files) {
        if (!urlIndexByFile.has(f.file)) { urlIndexByFile.set(f.file, paths.length); paths.push(f.absPath); }
      }
    }
    if (paths.length > 0) {
      const urls = mintMediaUrls(sceneId, paths);
      const names = new Set(media.map((b) => b.name));
      for (const r of results) {
        if (!names.has(r.binding)) continue;
        r.rows = r.rows.map((row) => {
          const idx = typeof row['file'] === 'string' ? urlIndexByFile.get(row['file']) : undefined;
          const url = idx === undefined ? undefined : urls[idx];
          return url === undefined ? row : { ...row, url };
        });
      }
    }
  }
  const rasters = bindings.filter((b) => b.asset === 'raster');
  if (rasters.length > 0) {
    const paths: string[] = [];
    const idxByBinding = new Map<string, number>();
    for (const decl of rasters) {
      if (decl.source.from === 'folder') continue;
      const resolved = await resolveBindingSource(sql, { orgId, projectId, source: decl.source, kind: 'raster' });
      const entry = results.find((r) => r.binding === decl.name);
      if (!resolved.ok) { if (entry) { entry.error = resolved.reason; entry.rows = []; } continue; }
      idxByBinding.set(decl.name, paths.length);
      paths.push(resolved.path);
    }
    if (paths.length > 0) {
      const urls = mintMediaUrls(`${sceneId}:raster`, paths);
      for (const r of results) {
        const idx = idxByBinding.get(r.binding);
        if (idx === undefined) continue;
        const url = urls[idx];
        if (url !== undefined) r.rows = r.rows.map((row) => ({ ...row, url }));
      }
    }
  }
}

/** The whole scene feed: the expanded document plus one entry per binding; one failed binding becomes one error entry. */
export async function serveSceneData(
  sql: postgres.Sql, orgId: string, sceneId: string, mintMediaUrls: MediaUrlMinter,
  /** Optional row key from detail routes; folds one eq predicate into rowKey-declaring query bindings. */
  rowKey?: string,
): Promise<ServeSceneData> {
  const host = await getSceneForHost(sql, { orgId, sceneId });
  if (!host) throw new Error(`scene not found in org: ${sceneId}`);
  const projectId = host.scene.projectId;
  // The served document is the expanded tree (Figma's rule): instances into their library items, glyph shapes stamped.
  const expanded = expandInstanceNodes(host.document, await libraryItemsFor(sql, orgId, projectId, instanceRefsIn(host.document))).doc;
  const document = stampIconGlyphs(expanded);
  const parsed = sceneBindingsSchema.safeParse(host.bindings);
  const bindings = parsed.success ? parsed.data : [];
  const results: ServeBindingFeed[] = [];
  for (const binding of bindings) results.push(await runOne(sql, orgId, projectId, binding, rowKey));
  await mintAssetUrls(sql, orgId, projectId, sceneId, bindings.filter((b): b is AssetBinding => b.kind === 'asset'), results, mintMediaUrls);
  return {
    scene: { id: host.scene.id, slug: host.scene.slug, title: host.scene.title, status: host.scene.status, headRevision: host.scene.headRevision },
    document,
    results,
    targetScreen: host.targetScreen,
  };
}

/** Re-executes exactly one declared binding; media and raster assets refuse (their URLs come from the whole feed). */
export async function serveSceneBindingData(
  sql: postgres.Sql, orgId: string, sceneId: string, bindingName: string, rowKey?: string,
): Promise<ServeBindingFeed> {
  const host = await getSceneForHost(sql, { orgId, sceneId });
  if (!host) throw new Error(`scene not found in org: ${sceneId}`);
  const parsed = sceneBindingsSchema.safeParse(host.bindings);
  const binding = (parsed.success ? parsed.data : []).find((b) => b.name === bindingName);
  if (!binding) throw new Error(`binding not declared on this scene: ${bindingName}`);
  if (binding.kind === 'asset' && binding.asset !== 'array') throw new Error(`${binding.asset} assets re-feed through the whole scene feed (their URLs are minted there), never the per-binding lane`);
  return runOne(sql, orgId, host.scene.projectId, binding, rowKey);
}

/** The only door to array payload bytes; validates the request against the binding's declared descriptor. */
export async function serveSceneProjection(
  sql: postgres.Sql, orgId: string, sceneId: string, bindingName: string, request: unknown,
): Promise<ServeSceneProjection> {
  const refuse = (error: string): ServeSceneProjection => ({ binding: bindingName, dtype: null, shape: [], data: null, error });
  const host = await getSceneForHost(sql, { orgId, sceneId });
  if (!host) return refuse(`scene not found in org: ${sceneId}`);
  const parsed = sceneBindingsSchema.safeParse(host.bindings);
  const binding = (parsed.success ? parsed.data : []).find((b) => b.name === bindingName);
  if (!binding) return refuse(`binding not declared on this scene: ${bindingName}`);
  if (binding.kind !== 'asset' || binding.asset !== 'array' || binding.descriptor === undefined || binding.source.from === 'folder') {
    return refuse(`binding '${bindingName}' is not an array asset - the projection lane serves arrays only`);
  }
  const req = projectionRequestSchema.safeParse(request ?? {});
  if (!req.success) return refuse(`invalid projection request: ${req.error.issues[0]?.message ?? 'malformed'}`);
  const src = await resolveBindingSource(sql, { orgId, projectId: host.scene.projectId, source: binding.source, kind: 'array' });
  if (!src.ok) return refuse(src.reason);
  try {
    const proj = readProjection({ path: src.path, descriptor: binding.descriptor, request: req.data });
    const data = proj.data.buffer.slice(proj.data.byteOffset, proj.data.byteOffset + proj.data.byteLength) as ArrayBuffer;
    return { binding: bindingName, dtype: proj.dtype, shape: proj.shape, data, error: null };
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
}
