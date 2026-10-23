'use strict';
// Tier 42 (FR-417, D-168.3) + Tier 46 (FR-421, D-172): THE SEALED OPERATION WORKER —
// plain CJS so no bundler ever touches the pyodide require. Loads the VENDORED runtime
// ONCE (indexURL = the hash-pinned resources dir; packages resolve from the local lock —
// NO network primitive exists in here), then serves a MESSAGE LOOP: per execution it
// remounts ONLY that execution's workspace, runs the operation's pinned code in a FRESH
// python globals namespace (the module-state bleed is the correctness risk the WARM≡COLD
// pin kills — an accumulator defined by op code can never survive into the next run),
// and reports. The host owns the clock, the two-stage kill, and every recycle decision.
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

async function main() {
  const t0 = Date.now();
  const { loadPyodide } = require(workerData.pyodideJs);
  let stdio = [];
  const capture = (line) => { stdio.push(String(line)); if (stdio.length > 200) stdio.shift(); };
  const py = await loadPyodide({ indexURL: workerData.indexURL, stdout: capture, stderr: capture });
  if (workerData.interruptBuffer) py.setInterruptBuffer(new Uint8Array(workerData.interruptBuffer));
  const loadMs = Date.now() - t0;
  let mounted = false;
  // Tier 46 (FR-423, D-174): ort-wasm loads LAZILY, once per worker, from the vendored
  // dir (file:// wasmPaths — the Windows ESM law; spike-proven). Only model-carrying
  // executions ever touch it.
  let ort = null;
  const loadOrt = () => {
    if (ort) return ort;
    if (!workerData.onnxDir) throw new Error('this environment has no vendored inference runtime');
    ort = require(workerData.onnxDir + '/ort.js');
    ort.env.wasm.numThreads = 1; // no nested workers inside the sealed worker
    ort.env.wasm.wasmPaths = pathToFileURL(workerData.onnxDir + '/').href;
    return ort;
  };
  parentPort.postMessage({ kind: 'booted', loadMs, rssMb: Math.round(process.memoryUsage().rss / 1e6) });

  parentPort.on('message', async (msg) => {
    if (!msg || msg.kind !== 'exec') return;
    const execId = msg.execId;
    stdio = [];
    let ns = null;
    let session = null;
    let toolOnnx = null;
    try {
      // Workspace REMOUNT: the previous execution's mount dies with it — a warm worker
      // never sees another run's files.
      if (mounted) {
        py.FS.unmount('/workspace');
        mounted = false;
      } else {
        try { py.FS.mkdir('/workspace'); } catch { /* exists from a prior boot path */ }
      }
      py.FS.mount(py.FS.filesystems.NODEFS, { root: msg.workspaceDir }, '/workspace');
      mounted = true;
      // Tier 46 (FR-423): the model session — bytes re-verified against the pin HERE
      // (defense in depth beside the executor's check; refuse on drift, every load),
      // handed to ort as a BUFFER (the fetch()ing create(path) is structurally unused).
      if (msg.model) {
        const o = loadOrt();
        const bytes = readFileSync(msg.model.path);
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== msg.model.sha256) throw new Error('model bytes do not match the pinned hash — refusing a drifted model');
        session = await o.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
        // THE BRIDGE (shape a, spike-ruled): python calls TOOL_ONNX(flat_values, dims)
        // → {data, dims} back. Single input/output v1 (the recorded ceiling). Injected
        // into the FRESH NAMESPACE below — never a JS global (nothing outlives the run).
        toolOnnx = async (data, dims) => {
          const flat = new Float32Array(data.toJs ? data.toJs() : data);
          const shape = (dims.toJs ? dims.toJs() : dims).map(Number);
          const feeds = {};
          feeds[session.inputNames[0]] = new ort.Tensor('float32', flat, shape);
          const out = await session.run(feeds);
          const t = out[session.outputNames[0]];
          return { data: Array.from(t.data, Number), dims: t.dims.map(Number) };
        };
      }
      // Offline package resolution per execution: scan THIS code's imports against the
      // local lock and load only what it names — from the pinned dir, never a network.
      await py.loadPackagesFromImports(msg.code);
      // THE FRESH NAMESPACE (the warm≡cold law's mechanism): module-level state the op
      // code defines lives in this dict and dies with it.
      ns = py.globals.get('dict')();
      ns.set('INPUTS_JSON', JSON.stringify(msg.inputs));
      if (toolOnnx) ns.set('TOOL_ONNX', toolOnnx);
      py.runPython([
        'import json',
        'INPUTS = json.loads(INPUTS_JSON)',
        "OUTPUT_DIR = '/workspace/outputs'",
      ].join('\n'), { globals: ns });
      // runPythonAsync: identical semantics for ordinary code, and model-carrying code
      // may `await TOOL_ONNX(...)` at top level.
      await py.runPythonAsync(msg.code, { globals: ns });
      parentPort.postMessage({
        kind: 'done', execId,
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
        stdio: stdio.slice(-40).join('\n').slice(0, 2000),
      });
    } catch (e) {
      parentPort.postMessage({
        kind: 'failed', execId,
        error: String((e && e.message) || e).slice(0, 1200),
        stdio: stdio.slice(-40).join('\n').slice(0, 2000),
      });
    } finally {
      if (ns) { try { ns.destroy(); } catch { /* already gone */ } }
      if (session) { try { await session.release(); } catch { /* freed with the worker */ } }
    }
  });
}

main().catch((e) => {
  parentPort.postMessage({ kind: 'boot_failed', error: String((e && e.message) || e).slice(0, 1200) });
});
