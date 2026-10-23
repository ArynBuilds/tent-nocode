import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { createOrgComponent, parseStoredDefinition, validateOrgDefinition, type ProjectDefinition } from './library.js';

// Single-component file export/import; import runs the same gate as authoring.

const ACTOR = 'kernel.scenes';

export const COMPONENT_FILE_FORMAT = 'lsg-component@1';

export interface ComponentExportFile {
  format: string;
  definition: ProjectDefinition;
  contentHash: string;
  provenance: { exportedFrom: string; exportedAt: string };
}

/** Sha256 over the definition serialized with sorted keys; stable across JSON round-trips. */
export function componentContentHash(definition: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex');
}

export async function exportComponent(
  sql: postgres.Sql, input: { orgId: string; ref: string },
): Promise<{ ok: true; file: ComponentExportFile } | { ok: false; errors: string[] }> {
  const at = input.ref.lastIndexOf('@');
  const name = input.ref.slice(0, at);
  const version = Number(input.ref.slice(at + 1));
  const [row] = await sql<{ definition: unknown; created_at: string }[]>`
    select definition, created_at from component_definitions
    where org_id = ${input.orgId} and name = ${name} and version = ${version}`;
  if (!row) return { ok: false, errors: [`'${input.ref}' is not in this org's library`] };
  // one export lane for both definition kinds
  const definition = parseStoredDefinition(row.definition);
  const file: ComponentExportFile = {
    format: COMPONENT_FILE_FORMAT,
    definition,
    contentHash: componentContentHash(definition),
    provenance: { exportedFrom: input.orgId, exportedAt: new Date(row.created_at).toISOString() },
  };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'component.exported',
    payload: { ref: input.ref, contentHash: file.contentHash },
  });
  return { ok: true, file };
}

/** Deep file validation without DB: format, hash, and the authoring gate; a file imports at version 1 under a local name. */
export function validateComponentFile(file: unknown): { ok: true; def: ProjectDefinition } | { ok: false; errors: string[] } {
  if (file === null || typeof file !== 'object') return { ok: false, errors: ['the import is not a component file'] };
  const f = file as Partial<ComponentExportFile>;
  if (f.format !== COMPONENT_FILE_FORMAT) {
    return { ok: false, errors: [`unknown file format '${String(f.format)}' — this build imports ${COMPONENT_FILE_FORMAT} (refuse-newer, D-146)`] };
  }
  if (typeof f.contentHash !== 'string' || componentContentHash(f.definition) !== f.contentHash) {
    return { ok: false, errors: ['content hash mismatch — the file was altered after export; re-export it'] };
  }
  return validateOrgDefinition(f.definition);
}

export async function importComponent(
  sql: postgres.Sql,
  input: {
    orgId: string;
    /** The copy lands in this project. */
    projectId: string | null;
    file: unknown;
    /** Declared shape name -> this org's dataset. */
    shapeMapping?: Record<string, string>;
    createdBy: string;
  },
): Promise<{ ok: true; ref: string } | { ok: false; errors: string[] }> {
  const valid = validateComponentFile(input.file);
  if (!valid.ok) return valid;
  const file = input.file as ComponentExportFile;

  // every declared dataShape must be mapped or explicitly '' to skip
  const shapes = Object.keys((valid.def as { dataShapes?: Record<string, unknown> }).dataShapes ?? {});
  const mapping = input.shapeMapping ?? {};
  const unmapped = shapes.filter((s) => mapping[s] === undefined);
  if (unmapped.length > 0) {
    return { ok: false, errors: [`data shapes [${unmapped.join(', ')}] are unmapped — map each onto one of your datasets, or '' to skip it`] };
  }

  const [taken] = await sql<{ version: number }[]>`
    select version from component_definitions
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${valid.def.name}
    order by version desc limit 1`;
  if (taken) {
    return { ok: false, errors: [`'${valid.def.name}' already exists in this project's library at v${taken.version} — foreign lineage never splices into local lineage; rename before import (the file's definition.name is yours to change)`] };
  }

  const definition = { ...valid.def, version: 1, provenance: { importedFrom: file.provenance.exportedFrom, originalHash: file.contentHash } };
  const created = await createOrgComponent(sql, { orgId: input.orgId, projectId: input.projectId, definition, createdBy: input.createdBy });
  if (!created.ok) return created;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'component.imported',
    payload: { ref: created.ref, originalHash: file.contentHash, importedFrom: file.provenance.exportedFrom, shapeMapping: mapping },
  });
  return { ok: true, ref: created.ref };
}
