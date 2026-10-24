import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { readFileSync as readBytes } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { operationCodeHash } from '@nodeloom/kernel';
import { parseNpyHeader, type DatasetQuery } from '@nodeloom/core';
import { readFileSync } from 'node:fs';
import { toOpsKernelPort, type OpsKernelPort } from '../kernelPort.js';
import { getOpsPool } from './workerPool.js';

// Claims pending operation executions and runs them in the sealed worker with zero
// model involvement: verify the code hash, materialize declared inputs, run, collect
// declared outputs, register products. Workspace lives under workspaceRoot/ops/<id>.

export interface OpsExecutorConfig {
  workerFile: string;
  pyodideDir: string;
  workspaceRoot: string;
  timeoutMs?: number;
  /** Vendored ONNX Runtime wasm dir; absent means model-carrying operations fail honestly. */
  onnxDir?: string;
}

export const OPS_EXECUTION_TIMEOUT_MS = 300_000;

/** Dataset inputs materialize whole or refuse with a named reason, never a silent slice. */
export const OP_DATASET_INPUT_ROW_CEILING = 500_000;
const DATASET_PAGE = 20_000;

export async function materializeDatasetInput(
  db: postgres.Sql | OpsKernelPort,
  input: { orgId: string; projectId?: string | null; dataset: string; file: string; ceiling?: number; pageSize?: number; query?: DatasetQuery },
): Promise<number> {
  const port = toOpsKernelPort(db);
  // Dataset inputs resolve within the execution's project.
  const projectId = input.projectId ?? null;
  const ceiling = input.ceiling ?? OP_DATASET_INPUT_ROW_CEILING;
  const pageSize = input.pageSize ?? DATASET_PAGE;
  // A declared query materializes exactly the filtered rows; past the limit it refuses.
  if (input.query !== undefined) {
    const res = await port.queryDatasetRows({ orgId: input.orgId, projectId, dataset: input.dataset, query: input.query });
    if (!res.ok) throw new Error(`dataset '${input.dataset}' query failed: ${res.error}`);
    if (res.total > res.rows.length) {
      throw new Error(
        `dataset '${input.dataset}' query matches ${res.total} rows — beyond its ${res.rows.length}-row limit; ` +
        'raise the query limit (≤10k) or narrow the where — refusing rather than computing on a slice',
      );
    }
    const fd = openSync(input.file, 'w');
    try {
      writeSync(fd, '[' + res.rows.map((r) => JSON.stringify(r)).join(',') + ']');
      return res.rows.length;
    } finally { closeSync(fd); }
  }
  const total = await port.countDatasetRows(input.orgId, projectId, input.dataset);
  if (total > ceiling) {
    throw new Error(
      `dataset '${input.dataset}' has ${total} rows — beyond the ${ceiling}-row operation-input ceiling; ` +
      'refusing rather than computing on a slice (split the dataset, or this is the big-tables rung)',
    );
  }
  const fd = openSync(input.file, 'w');
  try {
    writeSync(fd, '[');
    let written = 0;
    // The keyset cursor keeps created_at as text end to end (microsecond truncation trap).
    let cursor: { ca: string; id: string } | null = null;
    for (;;) {
      const page = await port.readDatasetRowsPage(input.orgId, projectId, input.dataset, cursor, pageSize);
      if (page.length === 0) break;
      writeSync(fd, (written === 0 ? '' : ',') + page.map((r) => JSON.stringify(r.row)).join(','));
      written += page.length;
      const last = page[page.length - 1]!;
      cursor = { ca: last.ca, id: last.id };
      if (page.length < pageSize) break;
    }
    writeSync(fd, ']');
    return written;
  } finally { closeSync(fd); }
}
const RASTER_MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  webp: (b) => b.length > 12 && b.toString('latin1', 8, 12) === 'WEBP',
};

export async function processPendingOperationExecutions(
  db: postgres.Sql | OpsKernelPort, cfg: OpsExecutorConfig,
): Promise<'ran' | 'idle'> {
  const port = toOpsKernelPort(db);
  const claim = await port.claimNextExecution();
  if (!claim) {
    // Even an idle pass ages the warm pool so nothing warm lingers for hours.
    await getOpsPool({ workerFile: cfg.workerFile, pyodideDir: cfg.pyodideDir }).sweepIdle();
    return 'idle';
  }
  try {
    const op = await port.resolveOperation(claim.orgId, { name: claim.operation, version: claim.version }, claim.projectId);
    if (!op) throw new Error(`operation '${claim.operation}@${claim.version}' not found`);
    if (op.runtime === 'native') {
      throw new Error('native operations need the per-operation two-yes consent, which is not built yet — v1 executes wasm only');
    }
    // The drift tripwire: the pinned hash is the identity; a mismatch REFUSES.
    if (operationCodeHash(op.code) !== op.codeHash) {
      throw new Error(`code hash mismatch for '${op.name}@${op.version}' — refusing a drifted operation`);
    }

    const wsDir = join(cfg.workspaceRoot, 'ops', claim.id);
    const inputsDir = join(wsDir, 'inputs');
    const outputsDir = join(wsDir, 'outputs');
    mkdirSync(inputsDir, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });

    // Materialize inputs per the contract: params pass through; file inputs COPY into the
    // sandbox's only mounted dir (the source path never enters the worker).
    const inputs: Record<string, string | number | boolean> = {};
    for (const [key, decl] of Object.entries(op.ioContract.inputs)) {
      const value = claim.inputs[key];
      if (decl.type === 'param') {
        const v = value ?? decl.default;
        if (v === undefined || typeof v === 'object') throw new Error(`input '${key}' missing at execution`);
        inputs[key] = v;
        continue;
      }
      // The items lane: inline transit rows ride a dataset slot as {__rows}.
      if (decl.type === 'dataset' && typeof value === 'object' && value !== null && Array.isArray((value as { __rows?: unknown }).__rows)) {
        const file = join(inputsDir, `${key}.json`);
        writeFileSync(file, JSON.stringify((value as { __rows: unknown[] }).__rows));
        inputs[key] = `/workspace/inputs/${key}.json`;
        continue;
      }
      if (typeof value !== 'string') throw new Error(`input '${key}' missing at execution`);
      // File inputs copy into the sandbox only from the workspace root or a granted
      // folder; the source path never enters the worker.
      if (decl.type === 'file') {
        const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
        const target = norm(value);
        const allowed: string[] = [norm(cfg.workspaceRoot)];
        for (const g of await port.listFolderGrantPaths(claim.orgId)) allowed.push(norm(g));
        if (!allowed.some((p) => target.startsWith(p + '/') || target === p)) {
          throw new Error(`input '${key}': the file is outside the granted reach — it must live under the workspace or a granted folder`);
        }
        if (!existsSync(value)) throw new Error(`input '${key}': file not found (${value})`);
        if (statSync(value).size > 50 * 1024 * 1024) {
          throw new Error(`input '${key}': the file exceeds the 50MB ceiling`);
        }
        const extRaw = (value.split('.').pop() ?? 'bin').toLowerCase();
        const ext = /^[a-z0-9]{1,8}$/.test(extRaw) ? extRaw : 'bin';
        const file = join(inputsDir, `${key}.${ext}`);
        copyFileSync(value, file);
        inputs[key] = `/workspace/inputs/${key}.${ext}`;
        continue;
      }
      if (decl.type === 'dataset') {
        const file = join(inputsDir, `${key}.json`);
        await materializeDatasetInput(port, {
          orgId: claim.orgId, projectId: claim.projectId, dataset: value, file,
          ...(decl.query !== undefined ? { query: decl.query } : {}),
        });
        inputs[key] = `/workspace/inputs/${key}.json`;
        continue;
      }
      const hit = await port.resolveDerivedOutput({ orgId: claim.orgId, projectId: claim.projectId, name: value });
      if (!hit) throw new Error(`input '${key}': registered output '${value}' no longer resolves`);
      if (!existsSync(hit.path)) throw new Error(`input '${key}': output '${value}' file is gone from disk`);
      const ext = decl.type === 'array' ? 'npy' : String(hit.descriptor['format'] ?? 'png');
      const file = join(inputsDir, `${key}.${ext}`);
      copyFileSync(hit.path, file);
      inputs[key] = `/workspace/inputs/${key}.${ext}`;
    }

    // Model-carrying operations use a content-addressed store, hash-verified at every load.
    let model: { path: string; sha256: string } | undefined;
    if (op.modelHash !== null) {
      if (cfg.onnxDir === undefined) {
        throw new Error(`'${op.name}@${op.version}' carries a model but this environment has no vendored inference runtime`);
      }
      const storeDir = join(cfg.workspaceRoot, 'ops-models');
      const storePath = join(storeDir, `${op.modelHash}.onnx`);
      if (!existsSync(storePath)) {
        if (op.modelPath === null || !existsSync(op.modelPath)) {
          throw new Error(`model file for '${op.name}@${op.version}' is gone (${op.modelPath ?? 'no source recorded'}) - register it again with the model present`);
        }
        const actual = createHash('sha256').update(readBytes(op.modelPath)).digest('hex');
        if (actual !== op.modelHash) throw new Error(`model source drifted from its pin — refusing ('${op.name}@${op.version}')`);
        mkdirSync(storeDir, { recursive: true });
        copyFileSync(op.modelPath, storePath);
      } else {
        const actual = createHash('sha256').update(readBytes(storePath)).digest('hex');
        if (actual !== op.modelHash) throw new Error(`model store drifted from its pin — refusing ('${op.name}@${op.version}')`);
      }
      model = { path: storePath, sha256: op.modelHash };
    }

    // The warm pool amortizes boot; every per-execution wall still fires unchanged.
    const pool = getOpsPool({
      workerFile: cfg.workerFile, pyodideDir: cfg.pyodideDir,
      ...(cfg.onnxDir !== undefined ? { onnxDir: cfg.onnxDir } : {}),
    });
    const res = await pool.run({
      workspaceDir: wsDir,
      code: op.code, inputs, timeoutMs: cfg.timeoutMs ?? OPS_EXECUTION_TIMEOUT_MS,
      ...(model !== undefined ? { model } : {}),
    });
    if (!res.ok) {
      throw new Error(res.error + (res.stdio ? `\n--- output tail ---\n${res.stdio}` : ''));
    }

    // Collect declared outputs; each must exist, parse, and register through the one lane.
    const registered: Record<string, string> = {};
    for (const [name, decl] of Object.entries(op.ioContract.outputs)) {
      // A dataset output lands as table rows, never a derived output; the file shape is
      // {"columns": {...}, "rows": [...]}. A landing refusal fails with the named reason.
      if (decl.kind === 'dataset') {
        const file = join(outputsDir, `${name}.json`);
        if (!existsSync(file)) {
          throw new Error(`declared output '${name}' was not produced (expected outputs/${name}.json = {"columns":{...},"rows":[...]})`);
        }
        let parsedFile: unknown;
        try { parsedFile = JSON.parse(readFileSync(file, 'utf8')); } catch {
          throw new Error(`declared output '${name}' is not valid JSON`);
        }
        const shaped = parsedFile as { columns?: unknown; rows?: unknown };
        if (shaped === null || typeof shaped !== 'object'
          || shaped.columns === null || typeof shaped.columns !== 'object' || Array.isArray(shaped.columns)
          || !Array.isArray(shaped.rows)) {
          throw new Error(`declared output '${name}' must be {"columns": {col: type}, "rows": [...]}`);
        }
        const target = decl.dataset ?? String(claim.inputs[decl.datasetFrom!] ?? '');
        if (target === '') throw new Error(`output '${name}' resolved no target table`);
        const landed = await port.landRowsOutput({
          orgId: claim.orgId, projectId: claim.projectId, executionId: claim.id, operation: op.name,
          dataset: target, ...(decl.key !== undefined ? { key: decl.key } : {}),
          columns: shaped.columns as Record<string, unknown>, rows: shaped.rows,
        });
        if (!landed.ok) throw new Error(`output '${name}' could not land in '${target}' — ${landed.reason}`);
        continue;
      }
      const ext = decl.kind === 'array' ? 'npy' : decl.format!;
      const file = join(outputsDir, `${name}.${ext}`);
      if (!existsSync(file)) {
        throw new Error(`declared output '${name}' was not produced (expected outputs/${name}.${ext})`);
      }
      let descriptor: Record<string, unknown>;
      if (decl.kind === 'array') {
        let head;
        try {
          head = parseNpyHeader(new Uint8Array(readFileSync(file).subarray(0, 4096)));
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          // An empty np.array([]) dies with a parser-flavored message; translate it.
          const empty = /shape entry '0'/.test(m);
          throw new Error(`declared output '${name}' is not a registrable .npy (${m})`
            + (empty
              ? " — the array is EMPTY (a zero-extent dimension). v1 outputs must be non-empty: emit empty results as dataset ROWS (a count of 0 is honest data) or guard the empty case in the operation's code"
              : ''));
        }
        descriptor = {
          dtype: head.dtype, shape: head.shape,
          axes: decl.axes && decl.axes.length === head.shape.length
            ? decl.axes
            : head.shape.map((_, i) => `dim${i}`),
        };
      } else {
        const buf = readFileSync(file);
        if (!RASTER_MAGIC[decl.format!]?.(buf)) {
          throw new Error(`declared output '${name}' is not a valid ${decl.format} file`);
        }
        descriptor = { format: decl.format };
      }
      const reg = await port.registerDerivedOutput({
        orgId: claim.orgId, projectId: claim.projectId, runId: claim.id, name,
        // Only array/raster reach the register lane; datasets landed above.
        kind: decl.kind === 'array' ? 'array' : 'raster',
        path: file, descriptor, allowedRoots: [wsDir],
      });
      if (!reg.ok) throw new Error(`output '${name}' failed registration: ${reg.reason}`);
      registered[name] = reg.outputId;
    }
    await port.confirmDerivedOutputs({ orgId: claim.orgId, runId: claim.id, runSucceeded: true });
    await port.settleExecution({ orgId: claim.orgId, executionId: claim.id, ok: true, outputs: registered });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await port.confirmDerivedOutputs({ orgId: claim.orgId, runId: claim.id, runSucceeded: false });
    } catch { /* never-fail settle side-effect */ }
    await port.settleExecution({ orgId: claim.orgId, executionId: claim.id, ok: false, error: message });
  }
  return 'ran';
}
