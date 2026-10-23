import { ipcMain } from 'electron';
import { workspaceRouter } from '@tent-nocode/kernel';
import type { MutationResult } from '../../shared/ipc.js';
import { workspaceCall } from '../workspaceClient.js';
import { nativeChannels } from './registry.js';

// THE DESKTOP MOUTH (electron-trpc's createIPCHandler shape): one ipcMain handler per router procedure,
// forwarding by name through the workspace door. A read answers raw (a failure throws its one sentence);
// a write answers the { ok, data | error } envelope. Names the native set claimed are left to it.

export function registerWorkspaceAdapter(): string[] {
  const forwarded: string[] = [];
  for (const [name, proc] of Object.entries(workspaceRouter)) {
    if (nativeChannels.has(name)) continue;
    if (proc.kind === 'read') {
      ipcMain.handle(name, async (_event, ...args: unknown[]): Promise<unknown> => workspaceCall(name, args));
    } else {
      ipcMain.handle(name, async (_event, ...args: unknown[]): Promise<MutationResult<unknown>> => {
        try {
          return { ok: true, data: await workspaceCall(name, args) };
        } catch (err) {
          // Never leak a stack trace to the renderer.
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
    }
    forwarded.push(name);
  }
  return forwarded;
}
