import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AuthState, DeskDelta, DeskInvokeChannel, LiveEvent } from '../shared/ipc.js';

// The only bridge between the sandboxed renderer and main: forwards typed IPC
// calls generically; precise typing lives in renderer/lib/desk.ts.

export interface DeskBridge {
  invoke: (channel: DeskInvokeChannel, ...args: unknown[]) => Promise<unknown>;
  /** Subscribes to live notifies; returns an unsubscribe function. */
  onLive: (cb: (event: LiveEvent) => void) => () => void;
  /** Live typing deltas — ephemeral push, never persisted. */
  onDelta: (cb: (event: DeskDelta) => void) => () => void;
  /** Second-instance --focus-scene forward. */
  onFocusScene: (cb: (slug: string) => void) => () => void;
  /** Session-state pushes — identity only, tokens never cross. */
  onAuth: (cb: (state: AuthState) => void) => () => void;
  /** A dropped File's absolute path; preload-only, the renderer never sees fs. */
  getPathForFile: (file: File) => string;
  /** A forwarded .tproject open offer, path only. */
  onOpenPackage: (cb: (path: string) => void) => () => void;
}

const LIVE_CHANNEL = 'desk:live';
const DELTA_CHANNEL = 'desk:delta';
const FOCUS_CHANNEL = 'desk:focus';
const AUTH_CHANNEL = 'desk:auth';
const OPEN_PACKAGE_CHANNEL = 'desk:openPackage';

const desk: DeskBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onLive: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LiveEvent): void => cb(payload);
    ipcRenderer.on(LIVE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(LIVE_CHANNEL, listener);
  },
  onDelta: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DeskDelta): void => cb(payload);
    ipcRenderer.on(DELTA_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DELTA_CHANNEL, listener);
  },
  onFocusScene: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string): void => cb(payload);
    ipcRenderer.on(FOCUS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(FOCUS_CHANNEL, listener);
  },
  onAuth: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AuthState): void => cb(payload);
    ipcRenderer.on(AUTH_CHANNEL, listener);
    return () => ipcRenderer.removeListener(AUTH_CHANNEL, listener);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPackage: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string): void => cb(payload);
    ipcRenderer.on(OPEN_PACKAGE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(OPEN_PACKAGE_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('desk', desk);
