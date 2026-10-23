import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { KEBAB_RE, importFormatFor, stripImportExt } from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { runOperation } from '../operations/dispatch.js';
import { ensureSeededParser, seededParserForExt } from '../operations/seeded.js';
import { importPackageAsUser } from '../human/doors.js';

// The one import dispatch: every dropped/opened file routes here; the format registry decides the package or rows lane.

const ACTOR = 'user';

export type ImportFileResult =
  | { ok: true; lane: 'package'; alreadyImported?: boolean; projectName?: string }
  | { ok: true; lane: 'rows'; table: string }
  | { ok: false; sentence: string };

/** filename to the born table's kebab name. */
export function tableNameForImport(fileName: string): string | null {
  const base = stripImportExt(basename(fileName));
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return KEBAB_RE.test(slug) ? slug : null;
}

export async function importFileAsUser(
  sql: postgres.Sql,
  input: {
    orgId: string; projectId: string | null; filePath: string; by: string;
    /** The runner's workspaceRoot; the rows lane stages under <staging>/imports/. */
    staging: string;
  },
): Promise<ImportFileResult> {
  const fmt = importFormatFor(basename(input.filePath));
  if (fmt === null) {
    return { ok: false, sentence: "this file isn't an importable format" };
  }
  if (fmt.lane === 'package') {
    const res = await importPackageAsUser(sql, {
      orgId: input.orgId, filePath: input.filePath, by: input.by,
      ...(input.projectId !== null ? { projectId: input.projectId } : {}),
    });
    if (!res.ok) return res;
    return {
      ok: true, lane: 'package',
      ...(res.alreadyImported === true ? { alreadyImported: true } : {}),
      ...(res.projectName !== undefined ? { projectName: res.projectName } : {}),
    };
  }
  // The rows lane: stage locally, queue through the DB half.
  const table = tableNameForImport(input.filePath);
  if (table === null) {
    return { ok: false, sentence: 'the file name gives no usable table name — rename the file' };
  }
  if (input.projectId === null) {
    return { ok: false, sentence: 'focus a project first — the table needs a home' };
  }
  const dir = join(input.staging, 'imports');
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, `${randomUUID()}.${fmt.ext}`);
  try {
    copyFileSync(input.filePath, staged);
  } catch {
    return { ok: false, sentence: 'this file could not be read' };
  }
  return queueRowsImportAsUser(sql, {
    orgId: input.orgId, projectId: input.projectId, fileName: basename(input.filePath),
    stagedPath: staged, ext: fmt.ext, by: input.by,
  });
}

/** The rows lane's DB half, serving both importFileAsUser and the workspace wall's humanImportRows channel. */
export async function queueRowsImportAsUser(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; fileName: string; stagedPath: string; ext: string; by: string },
): Promise<ImportFileResult> {
  const table = tableNameForImport(input.fileName);
  if (table === null) {
    return { ok: false, sentence: 'the file name gives no usable table name — rename the file' };
  }
  // Best-effort precheck; the landing re-checks.
  const [existing] = await sql<{ n: string }[]>`
    select count(r.id) as n from datasets d left join dataset_rows r on r.dataset_id = d.id
    where d.org_id = ${input.orgId} and ${projectArm(sql, input.projectId, 'd')} and d.name = ${table} and d.deleted_at is null
    group by d.id`;
  if (existing && Number(existing.n) > 0) {
    return { ok: false, sentence: `a table named '${table}' already has rows — rename the file` };
  }
  const parser = seededParserForExt(input.ext);
  if (parser === null) {
    return { ok: false, sentence: 'no parser is registered for this format' };
  }
  const seeded = await ensureSeededParser(sql, input.orgId, input.projectId, parser);
  if (!seeded.ok) return { ok: false, sentence: seeded.reason };
  const run = await runOperation(sql, {
    orgId: input.orgId, projectId: input.projectId, operation: parser.name,
    inputs: { file: input.stagedPath, table }, trigger: { kind: 'human' }, createdBy: input.by,
  });
  if (!run.ok) return { ok: false, sentence: run.reason };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'human.file_import_queued',
    payload: { path: input.fileName, table, executionId: run.executionId, by: input.by },
  });
  return { ok: true, lane: 'rows', table };
}
