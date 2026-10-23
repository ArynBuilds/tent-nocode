import { basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { app, dialog } from 'electron';
import type { ExportProjectDto, ExportProjectInput, PublishWebsiteDto, PublishWebsiteInput } from '../../shared/ipc.js';
import { sessionAccessToken } from '../account.js';
import { workspaceCall, workspaceOrigin } from '../workspaceClient.js';
import { assertOwnOrg, handle } from './registry.js';

// THE DELIVERY MOUTHS: export (the save dialog and the file write), publish and unpublish on the local server.
// Assembly runs in the server; the bearer never rides IPC.

export function registerDeliveryHandlers(): void {
  // Export builds in the local server; this mouth keeps only the save dialog and the file write.
  handle('exportProjectPackage', ['config'], async (_identity, _orgId: string, input: ExportProjectInput): Promise<ExportProjectDto> => {
    const wantedName = input.fileName.endsWith('.tproject') ? input.fileName : `${input.fileName}.tproject`;
    const picked = await dialog.showSaveDialog({
      title: 'Export project',
      defaultPath: join(app.getPath('downloads'), wantedName),
      filters: [{ name: 'Tent NoCode project', extensions: ['tproject'] }],
    });
    if (picked.canceled || picked.filePath === undefined || picked.filePath === '') return { canceled: true };
    const out = await workspaceCall('exportPackage', [{
      sceneSlugs: input.sceneSlugs,
      ...(input.inlineDatasets !== undefined ? { inlineDatasets: input.inlineDatasets } : {}),
      ...(input.notesProjects !== undefined ? { notesProjects: input.notesProjects } : {}),
      ...(input.license !== undefined ? { license: input.license } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      appVersion: app.getVersion(),
    }]) as { pkg: unknown; packageHash: string };
    const target = basename(picked.filePath).endsWith('.tproject') ? picked.filePath : `${picked.filePath}.tproject`;
    await writeFile(target, JSON.stringify(out.pkg), 'utf8');
    return { path: target, packageHash: out.packageHash };
  });

  // Publish: the local server assembles and serves it; this mouth carries picks and the bearer only.
  handle('publishWebsite', ['config'], async (_identity, _orgId: string, input: PublishWebsiteInput): Promise<PublishWebsiteDto> => {
    const token = sessionAccessToken();
    if (token === null) throw new Error('Unlock the app first - enter your password.');
    let out:
      | { ok: true; url: string; releaseHash: string; alreadyPublished?: boolean }
      | { ok: false; refusal?: string; error?: string; details?: string[] }
      | null;
    let status = 0;
    try {
      const res = await fetch(`${workspaceOrigin()}/workspace/publishWebsite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          appSlug: input.appSlug, appTitle: input.appTitle, sceneSlugs: input.sceneSlugs,
          ...(input.inlineDatasets !== undefined ? { inlineDatasets: input.inlineDatasets } : {}),
          ...(input.license !== undefined ? { license: input.license } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.entrySceneSlug !== undefined ? { entrySceneSlug: input.entrySceneSlug } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      status = res.status;
      out = (await res.json().catch(() => null)) as typeof out;
    } catch {
      throw new Error('the local server is not answering - restart the app');
    }
    if (out === null) throw new Error(`the publish door answered unreadably (${status})`);
    if (!out.ok) {
      const refusal = out.refusal ?? out.error ?? "Publishing didn't finish — your app is unchanged. Try again.";
      const details = 'details' in out && out.details?.length ? ` — ${out.details.join(' · ')}` : '';
      throw new Error(`${refusal}${details}`);
    }
    return { url: out.url, releaseHash: out.releaseHash, alreadyPublished: out.alreadyPublished === true };
  });

  // Unpublish: the local server owns the unpublish truth.
  handle('unpublishWebsite', ['config'], async (identity, orgId: string, appSlug: string): Promise<void> => {
    assertOwnOrg(identity, orgId);
    const token = sessionAccessToken();
    if (token === null) throw new Error('Unlock the app first - enter your password.');
    const res = await fetch(`${workspaceOrigin()}/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ appSlug }),
      signal: AbortSignal.timeout(60_000),
    });
    const out = (await res.json().catch(() => null)) as { ok: boolean; refusal?: string } | null;
    if (out === null || !out.ok) {
      throw new Error(out?.refusal ?? `the unpublish door answered unreadably (${res.status})`);
    }
    return undefined;
  });
}
