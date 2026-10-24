import { resolveCliEngine } from '@nodeloom/kernel';

// Resolves the org's engine credential from the vault at spawn time, in the registry's
// declared precedence order. Null means the CLI falls back to its own login.
// The value never logs and never enters the child env; the proxy holds it.
export interface ResolvedEngineCredential {
  engineId: string;
  kind: 'subscription-token' | 'api-key';
  /** The env var the ENGINE understands for this kind (registry-declared, driver-consumed). */
  envVar: string;
  value: string;
}

export async function resolveEngineCredential(
  resolveSecret: ((orgId: string, name: string) => Promise<string | null>) | undefined,
  orgId: string,
  engineId = 'claude',
): Promise<ResolvedEngineCredential | null> {
  if (resolveSecret === undefined) return null;
  const engine = resolveCliEngine(engineId);
  if (engine === null) return null;
  for (const k of engine.credentialKinds) {
    const value = await resolveSecret(orgId, k.vaultName).catch(() => null);
    if (value !== null && value !== '') {
      return { engineId, kind: k.kind, envVar: k.envVar, value };
    }
  }
  return null;
}
