import { isEngineReservedSecretName, resolveApiEngine, resolveCliEngine, listedEngineIds, type SecretMeta } from '@tent-nocode/kernel';
import {
  engineStatusRead, makeApiKeyProbe, makeCredentialProbe, probeBinaryVersion,
  removeEngineCredentialFlow, saveEngineCredentialFlow, type EngineVault,
} from '../engineCredentials.js';
import { workspaceCall } from '../workspaceClient.js';
import { assertOwnOrg, handle } from './registry.js';

// THE CREDENTIALS: engine credentials (probe and seal on this machine) and the secret names; a
// value crosses IPC once over TLS and never renders again - there is no read channel for values.

let versionCache: Promise<string | null> | null = null;
let inheritedCache: Promise<boolean> | null = null;

/** The wall's secret procedures as the flow's vault port. */
function wallVault(): EngineVault {
  return {
    set: async (name, value) => { await workspaceCall('secrets.set', [{ name, value }]); },
    remove: async (name) => { await workspaceCall('secrets.delete', [{ name }]); },
    names: async () => ((await workspaceCall('secrets.list', [])) as Array<{ name: string }>).map((m) => m.name),
  };
}

function assertNotEngineReserved(name: string): void {
  if (isEngineReservedSecretName(name)) {
    throw new Error(`"${name}" is a reserved engine credential — manage it under Settings › Engines`);
  }
}

export function registerCredentialHandlers(): void {
  handle('listEngines', [], async (identity, orgId: string) => {
    assertOwnOrg(identity, orgId);
    const ids = listedEngineIds();
    // One names read serves every engine's presence booleans.
    const vault = wallVault();
    const names = await vault.names().catch(() => [] as string[]);
    const cached: EngineVault = { ...vault, names: async () => names };
    const out = [];
    for (const id of ids) {
      const row = await engineStatusRead(cached, id, (binary) => {
        versionCache ??= probeBinaryVersion(binary, resolveCliEngine('claude')!.versionProbeArgs);
        return versionCache;
      });
      if (row !== null) out.push(row);
    }
    return out;
  });

  handle('probeInheritedLogin', [], async (identity, orgId: string) => {
    assertOwnOrg(identity, orgId);
    inheritedCache ??= makeCredentialProbe('claude')(null, '').then((r) => r.ok);
    return inheritedCache;
  });

  handle('saveEngineCredential', ['config'], async (identity, orgId: string, engineId: string, kind: string, value: string) => {
    assertOwnOrg(identity, orgId);
    const probe = resolveApiEngine(engineId) !== null
      ? makeApiKeyProbe(engineId)
      : (envVar: string, v: string) => makeCredentialProbe(engineId)(envVar, v);
    return saveEngineCredentialFlow(wallVault(), { probe }, { engineId, kind, value });
  });

  handle('removeEngineCredential', ['config'], async (identity, orgId: string, engineId: string, kind: string) => {
    assertOwnOrg(identity, orgId);
    await removeEngineCredentialFlow(wallVault(), { engineId, kind });
    return undefined;
  });

  // Optional projectId scopes the secret; absent means account level.
  handle('setSecret', ['config'], async (_identity, _orgId: string, name: string, value: string, projectId?: string) => {
    assertNotEngineReserved(name);
    await workspaceCall('secrets.set', [{ name, value, projectId: projectId ?? null }]);
  });

  handle('deleteSecret', ['config'], async (_identity, _orgId: string, name: string, projectId?: string) => {
    assertNotEngineReserved(name);
    await workspaceCall('secrets.delete', [{ name, projectId: projectId ?? null }]);
  });

  // A projectId lists that project's secrets; absent lists account-level only.
  handle('listSecretNames', [], async (_identity, _orgId: string, projectId?: string) => {
    const meta = await workspaceCall('secrets.list', []) as SecretMeta[];
    return meta
      .filter((m) => (projectId === undefined ? m.projectId === null : m.projectId === projectId))
      .map((m) => m.name)
      .filter((n) => !isEngineReservedSecretName(n));
  });
}
