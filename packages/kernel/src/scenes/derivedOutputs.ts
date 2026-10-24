import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type postgres from 'postgres';
import { z } from 'zod';
import {
  arrayDescriptorSchema, parseNpyHeader, npyByteLength, KEBAB_RE, DTYPE_BYTES,
  foldArrayStats, sceneBindingSchema,
  type ArrayDescriptor, type ArrayDtype, type ArrayStats, type AssetBinding, type StatsChunk,
} from '@nodeloom/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';

// The output ledger: a produced array/raster file registers as a typed row a screen binds as an ASSET
// binding (source { from: 'output' }); payload bytes never enter Postgres, and reads ride the projection
// lane or a minted URL.

const rasterDescriptorSchema = z.object({ format: z.enum(['png', 'jpeg', 'webp']) }).strict();

export interface RegisterOutputInput {
  orgId: string;
  /** Outputs live in the producing run's project. */
  projectId: string | null;
  runId: string;
  name: string;
  kind: 'array' | 'raster';
  /** Absolute path of the produced file. */
  path: string;
  descriptor: unknown;
  /** When present, `path` must live under one of these roots. */
  allowedRoots?: string[];
}

export type RegisterOutputResult =
  | { ok: true; outputId: string; name: string; kind: 'array' | 'raster'; contentHash: string; bytes: number; binding: AssetBinding }
  | { ok: false; reason: string };

function under(root: string, path: string): boolean {
  const r = resolve(root).toLowerCase();
  const p = resolve(path).toLowerCase();
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

async function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

/** Read just the .npy header bytes, never the payload. */
function readNpyHeadBytes(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    return new Uint8Array(head.buffer, 0, n);
  } finally {
    closeSync(fd);
  }
}

const STATS_CHUNK_BYTES = 8 * 1024 * 1024; // bounded streaming chunk size

function chunkView(dtype: ArrayDtype, buf: Buffer, bytes: number): StatsChunk {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes);
  switch (dtype) {
    case 'float32': return new Float32Array(ab);
    case 'float64': return new Float64Array(ab);
    case 'int16': return new Int16Array(ab);
    case 'int32': return new Int32Array(ab);
    case 'uint8': return new Uint8Array(ab);
    default: return new Uint16Array(ab);
  }
}

/** Streams the payload in bounded chunks and folds the stat set; memory stays flat at the chunk size. */
function computeNpyStats(path: string, dtype: ArrayDtype, dataOffset: number, totalBytes: number): ArrayStats {
  const elemBytes = DTYPE_BYTES[dtype];
  const chunkBytes = Math.max(elemBytes, Math.floor(STATS_CHUNK_BYTES / elemBytes) * elemBytes);
  const makeChunks = function* (): Generator<StatsChunk> {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(chunkBytes);
      let at = dataOffset;
      while (at < totalBytes) {
        const want = Math.min(chunkBytes, totalBytes - at);
        const got = readSync(fd, buf, 0, want, at);
        if (got <= 0) break;
        const whole = Math.floor(got / elemBytes) * elemBytes;
        if (whole === 0) break;
        yield chunkView(dtype, buf, whole);
        at += whole;
      }
    } finally {
      closeSync(fd);
    }
  };
  return foldArrayStats(() => makeChunks());
}

/** The asset binding a registered output is bound as: the one grammar's `asset` arm over `source { from: 'output' }`. */
export function assetBindingForOutput(output: { name: string; kind: 'array' | 'raster'; descriptor: Record<string, unknown> }): AssetBinding {
  const base = { name: output.name, kind: 'asset' as const, source: { from: 'output' as const, output: output.name } };
  const raw = output.kind === 'array'
    ? { ...base, asset: 'array' as const, descriptor: arrayDescriptorSchema.parse({ dtype: output.descriptor['dtype'], shape: output.descriptor['shape'], axes: output.descriptor['axes'], ...(output.descriptor['units'] !== undefined && output.descriptor['units'] !== null ? { units: output.descriptor['units'] } : {}) }) }
    : { ...base, asset: 'raster' as const, format: rasterDescriptorSchema.parse({ format: output.descriptor['format'] }).format };
  return sceneBindingSchema.parse(raw) as AssetBinding;
}

export async function registerDerivedOutput(sql: postgres.Sql, input: RegisterOutputInput): Promise<RegisterOutputResult> {
  if (!KEBAB_RE.test(input.name)) return { ok: false, reason: `name must be kebab-case: '${input.name}'` };
  if (!isAbsolute(input.path)) return { ok: false, reason: 'path must be absolute' };
  if (input.allowedRoots !== undefined && input.allowedRoots.length > 0
      && !input.allowedRoots.some((r) => under(r, input.path))) {
    return { ok: false, reason: "path is outside this run's workspace - outputs register from where the run produced them" };
  }
  if (!existsSync(input.path)) return { ok: false, reason: `file not found: ${input.path}` };
  const bytes = statSync(input.path).size;

  let descriptor: Record<string, unknown>;
  if (input.kind === 'array') {
    const parsed = arrayDescriptorSchema.safeParse(input.descriptor);
    if (!parsed.success) return { ok: false, reason: `descriptor invalid: ${parsed.error.issues[0]?.message ?? 'malformed'}` };
    // The descriptor is authoritative; the file is checked against it.
    let head;
    try {
      head = parseNpyHeader(readNpyHeadBytes(input.path));
    } catch (err) {
      return { ok: false, reason: `file is not a readable .npy: ${err instanceof Error ? err.message : String(err)}` };
    }
    const d: ArrayDescriptor = parsed.data;
    if (head.dtype !== d.dtype) return { ok: false, reason: `descriptor/file mismatch: descriptor says ${d.dtype}, file is ${head.dtype}` };
    if (head.shape.length !== d.shape.length || head.shape.some((v, i) => v !== d.shape[i])) {
      return { ok: false, reason: `descriptor/file mismatch: descriptor shape [${d.shape.join(', ')}], file shape [${head.shape.join(', ')}]` };
    }
    if (bytes !== head.dataOffset + npyByteLength(d.dtype, d.shape)) {
      return { ok: false, reason: 'file size does not match the declared dtype/shape - truncated or padded payload' };
    }
    descriptor = { ...d };
    // Stats failure is non-fatal: registers with stats null plus an audit event.
    try {
      descriptor['stats'] = { ...computeNpyStats(input.path, d.dtype, head.dataOffset, bytes) };
    } catch (err) {
      descriptor['stats'] = null;
      await emitEvent(sql, {
        orgId: input.orgId, actor: 'kernel.runner', type: 'output.stats_failed',
        payload: { name: input.name, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
      });
    }
  } else {
    const parsed = rasterDescriptorSchema.safeParse(input.descriptor);
    if (!parsed.success) return { ok: false, reason: "raster descriptor must be { format: 'png' | 'jpeg' | 'webp' }" };
    descriptor = { ...parsed.data };
  }

  const contentHash = await sha256File(input.path);
  descriptor['contentHash'] = contentHash;
  const [row] = await sql<{ id: string }[]>`
    insert into derived_outputs (org_id, project_id, run_id, name, kind, descriptor, path_key, content_hash)
    values (${input.orgId}, ${input.projectId}, ${input.runId}, ${input.name}, ${input.kind}, ${sql.json(descriptor as unknown as postgres.JSONValue)}, ${resolve(input.path)}, ${contentHash})
    returning id`;
  // Older registered generations of this name go stale as soon as a successor lands; rows survive.
  const staled = await sql<{ id: string }[]>`
    update derived_outputs set stale_at = now()
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and status = 'registered'
      and stale_at is null and id <> ${row!.id}
    returning id`;
  if (staled.length > 0) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: 'kernel.runner', type: 'output.staled',
      payload: { name: input.name, count: staled.length, successorOutputId: row!.id },
    });
  }
  return {
    ok: true, outputId: row!.id, name: input.name, kind: input.kind, contentHash, bytes,
    binding: assetBindingForOutput({ name: input.name, kind: input.kind, descriptor }),
  };
}

/** Settle re-verify: pending outputs flip registered when the file still hashes the same; otherwise missing, never deleted. */
export async function confirmDerivedOutputs(
  sql: postgres.Sql, input: { orgId: string; runId: string; runSucceeded: boolean },
): Promise<{ registered: number; missing: number }> {
  const pending = await sql<{ id: string; name: string; kind: string; path_key: string; content_hash: string }[]>`
    select id, name, kind, path_key, content_hash from derived_outputs
    where org_id = ${input.orgId} and run_id = ${input.runId} and status = 'pending'
    order by created_at asc, id asc`;
  let registered = 0, missing = 0;
  const registeredNames: string[] = [];
  for (const row of pending) {
    let ok = false;
    if (input.runSucceeded && existsSync(row.path_key)) {
      try {
        ok = (await sha256File(row.path_key)) === row.content_hash;
      } catch { ok = false; }
    }
    await sql`update derived_outputs set status = ${ok ? 'registered' : 'missing'} where id = ${row.id}`;
    await emitEvent(sql, {
      orgId: input.orgId, actor: 'kernel.runner',
      type: ok ? 'derived_output.registered' : 'derived_output.missing',
      payload: { runId: input.runId, outputId: row.id, name: row.name, kind: row.kind },
    });
    if (ok) { registered += 1; registeredNames.push(row.name); } else { missing += 1; }
  }
  // One call carries every registered name; dynamic import keeps the module graph acyclic; a reactive failure must not corrupt the settle.
  if (registeredNames.length > 0) {
    try {
      const { fireReactiveChains } = await import('../operations/reactive.js');
      await fireReactiveChains(sql, { orgId: input.orgId, registeredNames, causedByRunId: input.runId });
    } catch (err) {
      console.error('fireReactiveChains failed at confirm:', err instanceof Error ? err.message : String(err));
    }
  }
  return { registered, missing };
}

export interface BindableOutput {
  name: string;
  kind: 'array' | 'raster';
  descriptor: Record<string, unknown>;
  runId: string | null;
  createdAt: Date;
  /** Set when a successor generation has landed; consumers render it, never hide it. */
  staleAt: Date | null;
  /** The asset binding a screen declares to read it. */
  binding: AssetBinding;
}

/** The bindable inventory: newest registered row per name, each with the asset binding that reads it. */
export async function listBindableOutputs(sql: postgres.Sql, orgId: string, projectId: string | null = null): Promise<BindableOutput[]> {
  const rows = await sql<{ name: string; kind: 'array' | 'raster'; descriptor: Record<string, unknown>; run_id: string | null; created_at: Date; stale_at: Date | null }[]>`
    select distinct on (name) name, kind, descriptor, run_id, created_at, stale_at
    from derived_outputs
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and status = 'registered'
    order by name asc, created_at desc, id desc`;
  const out: BindableOutput[] = [];
  for (const r of rows) {
    let binding: AssetBinding;
    try { binding = assetBindingForOutput({ name: r.name, kind: r.kind, descriptor: r.descriptor }); } catch { continue; }
    out.push({ name: r.name, kind: r.kind, descriptor: r.descriptor, runId: r.run_id, createdAt: r.created_at, staleAt: r.stale_at, binding });
  }
  return out;
}

export interface ResolvedOutput {
  path: string;
  kind: 'array' | 'raster';
  descriptor: Record<string, unknown>;
  contentHash: string;
  /** Staleness travels with resolution. */
  staleAt: Date | null;
}

/** name to the newest registered payload location plus descriptor. */
export async function resolveDerivedOutput(
  sql: postgres.Sql, input: { orgId: string; projectId?: string | null; name: string },
): Promise<ResolvedOutput | null> {
  const [row] = await sql<{ path_key: string; kind: 'array' | 'raster'; descriptor: Record<string, unknown>; content_hash: string; stale_at: Date | null }[]>`
    select path_key, kind, descriptor, content_hash, stale_at from derived_outputs
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId ?? null)} and name = ${input.name} and status = 'registered'
    order by created_at desc, id desc limit 1`;
  return row ? { path: row.path_key, kind: row.kind, descriptor: row.descriptor, contentHash: row.content_hash, staleAt: row.stale_at } : null;
}

/** Resolves an asset binding's declared source to a real file: registered output (kind-checked) or granted-folder file (escape-proof). */
export async function resolveBindingSource(
  sql: postgres.Sql,
  input: {
    orgId: string;
    projectId?: string | null;
    source: { from: 'output'; output: string } | { from: 'file'; folder: string; file: string };
    kind: 'array' | 'raster';
  },
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (input.source.from === 'output') {
    const hit = await resolveDerivedOutput(sql, { orgId: input.orgId, projectId: input.projectId ?? null, name: input.source.output });
    if (!hit) return { ok: false, reason: `no registered output named '${input.source.output}'` };
    if (hit.kind !== input.kind) return { ok: false, reason: `output '${input.source.output}' is ${hit.kind}; this binding wants ${input.kind}` };
    if (!existsSync(hit.path)) return { ok: false, reason: `output '${input.source.output}' file is gone from disk (${hit.path})` };
    return { ok: true, path: hit.path };
  }
  const { findActiveFolderGrant } = await import('../consent.js');
  const grant = await findActiveFolderGrant(sql, input.orgId, input.source.folder);
  if (!grant) return { ok: false, reason: `folder '${input.source.folder}' has no live grant - grant the folder or bind a registered output` };
  const abs = resolve(input.source.folder, input.source.file);
  if (!under(input.source.folder, abs)) return { ok: false, reason: 'file escapes the granted folder' };
  if (!existsSync(abs)) return { ok: false, reason: `file not found: ${input.source.file}` };
  return { ok: true, path: abs };
}
