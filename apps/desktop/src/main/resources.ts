import { join } from 'node:path';

// The one place resolving packaged vs dev resource paths; every vendored asset is a SHIP_INVENTORY row.

export interface ShipResource {
  /** The name under `process.resourcesPath` (electron-builder `to:`). */
  to: string;
  /** The electron-builder `from:` path, relative to apps/desktop (the yml's cwd). */
  from: string;
  /** The dev path, relative to apps/desktop (app.getAppPath() in dev). */
  dev: string;
}

/** One row per vendored asset; keys are the resolver kinds. */
export const SHIP_INVENTORY = {
  fonts: { to: 'fonts', from: 'src/renderer/fonts', dev: 'src/renderer/fonts' },
  engines: { to: 'engines', from: 'resources/engines', dev: 'resources/engines' },
  pyodide: { to: 'pyodide', from: 'resources/pyodide', dev: 'resources/pyodide' },
  onnx: { to: 'onnx', from: 'resources/onnx', dev: 'resources/onnx' },
  'opsWorker.cjs': { to: 'opsWorker.cjs', from: '../../packages/runner/src/ops/opsWorker.cjs', dev: '../../packages/runner/src/ops/opsWorker.cjs' },
  'icon.png': { to: 'icon.png', from: 'resources/icon.png', dev: 'resources/icon.png' },
  roomsMigrations: { to: 'rooms-migrations', from: '../../packages/room-server/migrations', dev: '../../packages/room-server/migrations' },
  workspaceMigrations: { to: 'workspace-migrations', from: '../../packages/kernel/migrations', dev: '../../packages/kernel/migrations' },
} as const satisfies Record<string, ShipResource>;

export type ResourceKind = keyof typeof SHIP_INVENTORY;

interface ResourceContext {
  isPackaged: boolean;
  /** app.getAppPath() — apps/desktop in dev, the packaged app dir when packaged. */
  appPath: string;
  /** Test override; production reads process.resourcesPath. */
  resourcesPath?: string;
}

let ctx: ResourceContext | null = null;

/** Called once at main-process start (and by tests with a fake context). */
export function initResources(context: ResourceContext): void {
  ctx = context;
}

/** The one fork: packaged → resourcesPath/<to>, dev → appPath-relative dev path. */
export function resourcePath(kind: ResourceKind): string {
  if (ctx === null) throw new Error('resources: initResources() must run before resourcePath()');
  const row = SHIP_INVENTORY[kind];
  if (ctx.isPackaged) {
    const root = ctx.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (typeof root !== 'string' || root.length === 0) throw new Error('resources: packaged but process.resourcesPath is unset');
    return join(root, row.to);
  }
  return join(ctx.appPath, row.dev);
}
