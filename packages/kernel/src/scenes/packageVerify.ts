import { createHash } from 'node:crypto';
import {
  LSG_PACKAGE_FORMAT, SCENE_SCHEMA_VERSION, lsgPackageSchema, type LsgPackage,
} from '@tent-nocode/core';

// Canonical package hashing and stage-0 validation; lives in kernel because core must stay free of node builtins.

export function canonicalContentHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function packageHashOf(manifest: unknown, entries: unknown[]): string {
  return canonicalContentHash({ manifest, entries });
}

/** Pure validation run before any consent card; nothing downstream runs unless this returns ok. */
export function validateLsgPackage(raw: unknown):
  | { ok: true; pkg: LsgPackage }
  | { ok: false; errors: string[] } {
  const maybe = raw as { manifest?: { format?: unknown; schemaVersion?: unknown } } | null;
  const fmt = maybe?.manifest?.format;
  if (typeof fmt === 'string' && fmt !== LSG_PACKAGE_FORMAT) {
    return { ok: false, errors: [`this app reads ${LSG_PACKAGE_FORMAT}; the file is ${fmt} - an older or newer format is not read`] };
  }
  const sv = maybe?.manifest?.schemaVersion;
  if (typeof sv === 'number' && sv > SCENE_SCHEMA_VERSION) {
    return { ok: false, errors: [`refuse-newer: scene schema ${sv} is newer than this app's ${SCENE_SCHEMA_VERSION}`] };
  }
  const parsed = lsgPackageSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'package'}: ${i.message}`) };
  }
  const pkg = parsed.data;
  const errors: string[] = [];
  if (packageHashOf(pkg.manifest, pkg.entries) !== pkg.packageHash) errors.push('packageHash: content does not match the recorded hash (tampered or truncated)');
  const inClosure = new Map(pkg.manifest.closure.map((c) => [`${c.kind}:${c.name}`, c]));
  for (const e of pkg.entries) {
    const { kind: _k, name: _n, role: _r, contentHash: _h, ...body } = e as Record<string, unknown>;
    if (canonicalContentHash(body) !== e.contentHash) errors.push(`${e.kind}:${e.name}: entry content does not match its recorded hash`);
    const c = inClosure.get(`${e.kind}:${e.name}`);
    if (!c) errors.push(`${e.kind}:${e.name}: entry absent from the manifest closure`);
    else if (c.contentHash !== e.contentHash || c.role !== e.role) errors.push(`${e.kind}:${e.name}: closure row disagrees with the entry`);
  }
  if (pkg.manifest.closure.length !== pkg.entries.length) errors.push('closure: manifest closure and entries disagree in count');

  // every referenced chunk must exist, hash-match, and carry its recorded row count; unreferenced chunks refuse
  const referenced = new Set<string>();
  for (const e of pkg.entries) {
    if (e.kind !== 'table' || e.rowChunks === undefined) continue;
    if (e.rows !== undefined) { errors.push(`${e.kind}:${e.name}: carries both inline rows and rowChunks — one lane per dataset`); continue; }
    for (const chunk of e.rowChunks) {
      referenced.add(chunk.sha256);
      const rows = pkg.data?.[chunk.sha256];
      if (rows === undefined) { errors.push(`${e.kind}:${e.name}: data chunk ${chunk.sha256.slice(0, 12)}… is missing from the data lane`); continue; }
      if (canonicalContentHash(rows) !== chunk.sha256) errors.push(`${e.kind}:${e.name}: data chunk ${chunk.sha256.slice(0, 12)}… does not match its recorded hash (tampered or truncated)`);
      else if (rows.length !== chunk.rows) errors.push(`${e.kind}:${e.name}: data chunk ${chunk.sha256.slice(0, 12)}… carries ${rows.length} rows, the entry recorded ${chunk.rows}`);
    }
  }
  for (const key of Object.keys(pkg.data ?? {})) {
    if (!referenced.has(key)) errors.push(`data lane: chunk ${key.slice(0, 12)}… is referenced by no table entry`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, pkg };
}

/** The one reader of a dataset entry's travelling rows, inline or reassembled from the data lane; undefined means no rows. */
export function datasetEntryRows(pkg: LsgPackage, entry: LsgPackage['entries'][number]): Record<string, unknown>[] | undefined {
  if (entry.kind !== 'table') return undefined;
  if (entry.rows !== undefined) return entry.rows;
  if (entry.rowChunks === undefined) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const chunk of entry.rowChunks) out.push(...(pkg.data?.[chunk.sha256] ?? []));
  return out;
}
