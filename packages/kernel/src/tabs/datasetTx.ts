import { z } from 'zod';
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { validateRows } from './datasets.js';

// Multi-dataset transaction: one atomic batch of writes; all lands or none does, rows addressed by kernel row id only.

type RowSchema = Record<string, 'string' | 'number' | 'boolean'>;

const txItemSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append'), dataset: z.string().min(1), rows: z.array(z.record(z.unknown())).min(1).max(100) }).strict(),
  z.object({ op: z.literal('update'), dataset: z.string().min(1), _id: z.string().uuid(), set: z.record(z.unknown()).refine((s) => Object.keys(s).length >= 1, { message: 'update sets at least one column' }) }).strict(),
  z.object({ op: z.literal('delete'), dataset: z.string().min(1), _id: z.string().uuid() }).strict(),
]);
const txSchema = z.array(txItemSchema).min(1).max(20);
export type DatasetTxItem = z.infer<typeof txItemSchema>;

export type DatasetTxResult =
  | { ok: true; results: { dataset: string; op: string; accepted?: number; updated?: number; deleted?: number }[] }
  | { ok: false; errors: { index: number; reason: string }[] };

export async function datasetTx(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; runId: string | null; items: unknown },
): Promise<DatasetTxResult> {
  const parsed = txSchema.safeParse(input.items);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ index: typeof i.path[0] === 'number' ? i.path[0] : -1, reason: i.message })) };
  }
  const items = parsed.data;

  // Validate everything first: only a fully clean batch opens the transaction.
  const names = [...new Set(items.map((i) => i.dataset))];
  const datasets = new Map<string, { id: string; row_schema: RowSchema; deprecated_columns: string[] }>();
  for (const name of names) {
    const [d] = await sql<{ id: string; row_schema: RowSchema; deprecated_columns: string[] }[]>`
      select id, row_schema, deprecated_columns from datasets
      where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${name} and deleted_at is null`;
    if (d) datasets.set(name, d);
  }
  const errors: { index: number; reason: string }[] = [];
  interface Planned { index: number; item: DatasetTxItem; merged?: Record<string, unknown> }
  const planned: Planned[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const d = datasets.get(item.dataset);
    if (!d) { errors.push({ index: i, reason: `dataset '${item.dataset}' is not declared in this project` }); continue; }
    if (item.op === 'append') {
      // Appends are new writes: deprecated columns refuse.
      const verdict = validateRows(item.rows, d.row_schema);
      if (verdict.rejected.length > 0) {
        errors.push(...verdict.rejected.map((r) => ({ index: i, reason: `row ${r.index}: ${r.reason}` })));
        continue;
      }
      planned.push({ index: i, item });
    } else {
      const [row] = await sql<{ row: Record<string, unknown> }[]>`
        select row from dataset_rows where org_id = ${input.orgId} and dataset_id = ${d.id} and id = ${item._id}`;
      if (!row) { errors.push({ index: i, reason: `row '${item._id}' not found in '${item.dataset}'` }); continue; }
      if (item.op === 'update') {
        // The merged row must re-pass the row schema.
        const merged = { ...row.row, ...item.set };
        const verdict = validateRows([merged], d.row_schema, d.deprecated_columns ?? []);
        if (verdict.rejected.length > 0) {
          errors.push(...verdict.rejected.map((r) => ({ index: i, reason: `merged row: ${r.reason}` })));
          continue;
        }
        planned.push({ index: i, item, merged });
      } else {
        planned.push({ index: i, item });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }; // all-or-nothing: nothing landed

  const results: { dataset: string; op: string; accepted?: number; updated?: number; deleted?: number }[] = [];
  await sql.begin(async (tx) => {
    for (const p of planned) {
      const d = datasets.get(p.item.dataset)!;
      if (p.item.op === 'append') {
        for (const row of p.item.rows) {
          await tx`
            insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
            values (${input.orgId}, ${d.id}, ${tx.json(row as postgres.JSONValue)}, ${input.runId})`;
        }
        results.push({ dataset: p.item.dataset, op: 'append', accepted: p.item.rows.length });
      } else if (p.item.op === 'update') {
        await tx`
          update dataset_rows set row = ${tx.json(p.merged as postgres.JSONValue)}, evidence_run_id = ${input.runId}
          where org_id = ${input.orgId} and dataset_id = ${d.id} and id = ${p.item._id}`;
        results.push({ dataset: p.item.dataset, op: 'update', updated: 1 });
      } else {
        await tx`
          delete from dataset_rows
          where org_id = ${input.orgId} and dataset_id = ${d.id} and id = ${p.item._id}`;
        results.push({ dataset: p.item.dataset, op: 'delete', deleted: 1 });
      }
    }
  });
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.datasets', type: 'dataset.tx',
    payload: { runId: input.runId, items: results },
  });
  return { ok: true, results };
}
