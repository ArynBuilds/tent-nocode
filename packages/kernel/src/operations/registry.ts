import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { KEBAB_RE, datasetQuerySchema } from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';

// The operations registry: immutable name@version rows, hash-pinned code, declared io contracts.

const ACTOR = 'kernel.operations';

export const OPERATION_CODE_MAX_BYTES = 64 * 1024;

const ioName = z.string().regex(KEBAB_RE, 'kebab-case name, e.g. seg-threshold');

const opInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('array'), description: z.string().min(1) }).strict(),
  z.object({ type: z.literal('raster'), description: z.string().min(1) }).strict(),
  // A dataset input may declare a query, applied server-side at materialization.
  z.object({ type: z.literal('dataset'), description: z.string().min(1), query: datasetQuerySchema.optional() }).strict(),
  // A file input is an absolute path; the executor copies it into the sandbox.
  z.object({ type: z.literal('file'), description: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('param'),
    valueType: z.enum(['string', 'number', 'boolean']),
    description: z.string().min(1),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }).strict(),
]);

const opOutputSchema = z.object({
  // 'dataset' outputs are table rows written as outputs/<name>.json and landed by the executor.
  kind: z.enum(['array', 'raster', 'dataset']),
  description: z.string().min(1),
  /** Array outputs may pre-declare axis labels; absent means dim0..dimN. */
  axes: z.array(z.string().min(1).max(32)).max(5).optional(),
  /** Raster outputs MUST declare their web-decodable format. */
  format: z.enum(['png', 'jpeg', 'webp']).optional(),
  /** The table this output updates, rows matched by `key`; both together or neither. */
  dataset: z.string().regex(KEBAB_RE).optional(),
  key: z.string().min(1).max(64).optional(),
  /** Target table name arrives at dispatch in the named string param; exclusive with `dataset`. */
  datasetFrom: z.string().regex(KEBAB_RE).optional(),
}).strict()
  .refine((o) => o.kind !== 'raster' || o.format !== undefined, { message: 'raster outputs declare their format (png|jpeg|webp)' })
  .refine((o) => o.kind !== 'array' || o.format === undefined, { message: 'array outputs carry axes, never a raster format' })
  .refine((o) => o.kind === 'dataset' || (o.dataset === undefined && o.key === undefined && o.datasetFrom === undefined),
    { message: 'dataset/key/datasetFrom belong to dataset outputs only' })
  .refine((o) => o.kind !== 'dataset' || (o.axes === undefined && o.format === undefined),
    { message: 'dataset outputs carry no axes or raster format — they are table rows' })
  .refine((o) => o.kind !== 'dataset' || (o.dataset !== undefined) === (o.key !== undefined),
    { message: 'a bound dataset output names its table AND its key column together' })
  .refine((o) => o.dataset === undefined || o.datasetFrom === undefined,
    { message: 'dataset and datasetFrom are exclusive — a fixed table or a dispatch-named one, never both' });

export const operationContractSchema = z.object({
  inputs: z.record(ioName, opInputSchema).default({}),
  outputs: z.record(ioName, opOutputSchema).refine((o) => Object.keys(o).length >= 1, { message: 'an operation declares at least one output — compute with no product is not an operation' }),
}).strict()
  // datasetFrom must name a declared string param input.
  .superRefine((c, ctx) => {
    for (const [name, o] of Object.entries(c.outputs)) {
      const from = o.datasetFrom;
      if (from === undefined) continue;
      const inp = c.inputs[from];
      if (inp === undefined || inp.type !== 'param' || inp.valueType !== 'string') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs', name, 'datasetFrom'], message: `datasetFrom names a declared string param input ('${from}' is not one)` });
      }
    }
  });
export type OperationContract = z.infer<typeof operationContractSchema>;

export function operationCodeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export interface OperationInput {
  name: string;
  /** Owning project; null is the serving/whole-account lane only. */
  projectId: string | null;
  code: string;
  runtime: 'wasm' | 'native';
  ioContract: unknown;
  provenanceRunId?: string | null;
  /** Model triple: sha256 pin, source file, license — all three together or none. */
  modelHash?: string | null;
  modelPath?: string | null;
  modelLicense?: string | null;
}

/** Deep validation shared by the raise gate and createOperation. */
export function validateOperationInput(input: OperationInput): { ok: true; contract: OperationContract } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!KEBAB_RE.test(input.name)) errors.push(`name must be kebab-case: '${input.name}'`);
  if (typeof input.code !== 'string' || input.code.trim().length === 0) errors.push('code is empty');
  else if (Buffer.byteLength(input.code, 'utf8') > OPERATION_CODE_MAX_BYTES) errors.push(`code exceeds ${OPERATION_CODE_MAX_BYTES / 1024}KB`);
  if (input.runtime !== 'wasm' && input.runtime !== 'native') errors.push("runtime must be 'wasm' or 'native'");
  const parsed = operationContractSchema.safeParse(input.ioContract);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 10)) errors.push(`ioContract.${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, errors };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, contract: parsed.data };
}

export interface OperationRow {
  id: string;
  name: string;
  /** Owning project; null only on serving-lane rows. */
  projectId: string | null;
  version: number;
  code: string;
  codeHash: string;
  runtime: 'wasm' | 'native';
  ioContract: OperationContract;
  provenanceRunId: string | null;
  status: 'active' | 'retired';
  createdBy: string;
  createdAt: string;
  modelHash: string | null;
  modelPath: string | null;
  modelLicense: string | null;
}

/** Publishes a new immutable version at head+1; registration never edits. */
export async function createOperation(
  sql: postgres.Sql,
  input: OperationInput & { orgId: string; createdBy: string },
): Promise<{ ok: true; name: string; version: number; codeHash: string } | { ok: false; errors: string[] }> {
  const valid = validateOperationInput(input);
  if (!valid.ok) return valid;
  const codeHash = operationCodeHash(input.code);
  return sql.begin(async (tx) => {
    const [head] = await tx<{ version: number }[]>`
      select version from operations
      where org_id = ${input.orgId} and ${projectArm(tx as unknown as postgres.Sql, input.projectId)} and name = ${input.name}
      order by version desc limit 1`;
    const version = (head?.version ?? 0) + 1;
    await tx`
      insert into operations (org_id, project_id, name, version, code, code_hash, runtime, io_contract, provenance_run_id, created_by, model_hash, model_path, model_license)
      values (${input.orgId}, ${input.projectId}, ${input.name}, ${version}, ${input.code}, ${codeHash}, ${input.runtime},
              ${tx.json(valid.contract as unknown as postgres.JSONValue)}, ${input.provenanceRunId ?? null}, ${input.createdBy},
              ${input.modelHash ?? null}, ${input.modelPath ?? null}, ${input.modelLicense ?? null})`;
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: input.orgId, actor: ACTOR, type: 'operation.published',
      payload: {
        name: input.name, version, runtime: input.runtime, codeHash,
        provenanceRunId: input.provenanceRunId ?? null,
        outputs: Object.keys(valid.contract.outputs),
        ...(input.modelHash ? { modelHash: input.modelHash } : {}),
      },
    });
    return { ok: true, name: input.name, version, codeHash } as const;
  });
}

/** Retires every active version; pinned executions keep resolving. */
export async function retireOperation(
  sql: postgres.Sql, input: { orgId: string; projectId: string | null; name: string; reason: string },
): Promise<{ ok: true; retired: number } | { ok: false; errors: string[] }> {
  const rows = await sql<{ id: string }[]>`
    update operations set status = 'retired'
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and status = 'active'
    returning id`;
  if (rows.length === 0) return { ok: false, errors: [`'${input.name}' has no active versions to retire`] };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'operation.retired',
    payload: { name: input.name, versions: rows.length, reason: input.reason },
  });
  return { ok: true, retired: rows.length };
}

/** Exact version when given, else the newest active version; retired exact versions still resolve. */
export async function resolveOperation(
  sql: postgres.Sql, orgId: string, ref: { name: string; version?: number },
  projectId: string | null = null,
): Promise<OperationRow | null> {
  const rows = ref.version !== undefined
    ? await sql<Array<Record<string, unknown>>>`
        select * from operations
        where org_id = ${orgId} and ${projectArm(sql, projectId)} and name = ${ref.name} and version = ${ref.version}`
    : await sql<Array<Record<string, unknown>>>`
        select * from operations
        where org_id = ${orgId} and ${projectArm(sql, projectId)} and name = ${ref.name} and status = 'active'
        order by version desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r['id'] as string, name: r['name'] as string,
    projectId: (r['project_id'] as string | null) ?? null,
    version: r['version'] as number,
    code: r['code'] as string, codeHash: r['code_hash'] as string,
    runtime: r['runtime'] as 'wasm' | 'native',
    ioContract: operationContractSchema.parse(r['io_contract']),
    provenanceRunId: r['provenance_run_id'] as string | null,
    status: r['status'] as 'active' | 'retired',
    createdBy: r['created_by'] as string,
    createdAt: new Date(r['created_at'] as string).toISOString(),
    modelHash: (r['model_hash'] as string | null) ?? null,
    modelPath: (r['model_path'] as string | null) ?? null,
    modelLicense: (r['model_license'] as string | null) ?? null,
  };
}

export async function listOperations(
  sql: postgres.Sql, orgId: string, projectId: string | null = null,
): Promise<Array<Pick<OperationRow, 'name' | 'version' | 'runtime' | 'status' | 'createdAt'> & { outputs: string[] }>> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select name, version, runtime, io_contract, status, created_at from operations
    where org_id = ${orgId} and ${projectArm(sql, projectId)} order by name asc, version desc`;
  return rows.map((r) => ({
    name: r['name'] as string, version: r['version'] as number,
    runtime: r['runtime'] as 'wasm' | 'native', status: r['status'] as 'active' | 'retired',
    createdAt: new Date(r['created_at'] as string).toISOString(),
    outputs: Object.keys((r['io_contract'] as { outputs?: Record<string, unknown> }).outputs ?? {}),
  }));
}

/** Usage summary: executions per trigger kind plus scenes whose actions run this op. */
export async function operationUsage(
  sql: postgres.Sql, orgId: string, name: string, projectId: string | null = null,
): Promise<{ executions: Array<{ trigger: string; n: number }>; scenes: Array<{ slug: string; title: string }> }> {
  const executions = await sql<{ trigger: string; n: string }[]>`
    select coalesce(trigger->>'kind', '?') as trigger, count(*) as n
    from operation_executions
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and operation = ${name}
    group by 1 order by 1`;
  const scenes = await sql<{ slug: string; title: string }[]>`
    select distinct s.slug, s.title
    from scenes s, jsonb_array_elements(coalesce(s.actions, '[]'::jsonb)) as act,
         jsonb_array_elements(coalesce(act->'rules', '[]'::jsonb)) as rule
    where s.org_id = ${orgId} and ${projectArm(sql, projectId, 's')} and s.status != 'deleted'
      and rule->>'rule' = 'run_operation' and rule->>'operation' = ${name}
    order by s.slug asc`;
  return { executions: executions.map((e) => ({ trigger: e.trigger, n: Number(e.n) })), scenes };
}
