import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// `@tent-nocode/core`, `@tent-nocode/kernel`, and `@tent-nocode/runner` are
// workspace packages whose `package.json` `exports` point straight at
// TypeScript source (no build step) — fine for tooling that transpiles on
// the fly (tsc, Vitest), but `externalizeDepsPlugin()`'s default behavior
// externalizes every `dependencies` entry, including these, so the bundled
// main process would try to `import()` a raw `.ts` file at runtime and
// Node's ESM loader rejects it (`ERR_UNKNOWN_FILE_EXTENSION` — hit live via
// `main/runner/daemon.ts`'s `@tent-nocode/runner` import, which predates this
// exclusion list). Excluding them here lets electron-vite bundle +
// transpile them into `out/main/index.js` instead; true native/binary deps
// (`postgres`) stays external (embedded-postgres died at the E2 cutover).
const WORKSPACE_SOURCE_PACKAGES = ['@tent-nocode/core', '@tent-nocode/kernel', '@tent-nocode/runner', '@tent-nocode/room-server', '@tent-nocode/server'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_SOURCE_PACKAGES })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Per-run MCP servers, spawned as electron-as-node children (the browse lanes).
          browserMcp: resolve(__dirname, 'src/main/mcp/browserMcpEntry.ts'),
          panelBrowserMcp: resolve(__dirname, 'src/main/mcp/panelBrowserMcpEntry.ts'),
          toolsMcp: resolve(__dirname, 'src/main/mcp/toolsMcpEntry.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // The window is created with `sandbox: true` (main/index.ts) —
        // Electron's sandboxed preload loader runs the script through a
        // CommonJS-only runner (`runPreloadScript`) and cannot execute an
        // ESM preload ("Cannot use import statement outside a module"),
        // even though Electron 28+ supports ESM preload for *unsandboxed*
        // windows. This workspace is `"type": "module"`, so a plain `.js`
        // output would still be parsed as ESM by Node's loader — forcing
        // the `.cjs` extension overrides that regardless of package type.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
  },
});
