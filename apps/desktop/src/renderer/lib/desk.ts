import type { DeskApi, DeskInvokeChannel } from '../../shared/ipc.js';

/**
 * The ONLY way the renderer reaches data: the typed client over `window.desk.invoke`, the untyped
 * primitive the preload bridge exposes (electron-trpc's ipcLink shape). Every member is inferred from
 * the router and the native set - no list of names lives here. No component calls `window.desk.invoke`.
 */
const client = new Proxy({} as Record<string, unknown>, {
  get(_target, channel: string | symbol) {
    if (channel === 'onLive') return (cb: (event: unknown) => void) => window.desk.onLive(cb);
    if (typeof channel !== 'string') return undefined;
    return (...args: unknown[]) => window.desk.invoke(channel as DeskInvokeChannel, ...args);
  },
});

export const desk = client as unknown as DeskApi;
