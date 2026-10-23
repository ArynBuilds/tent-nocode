import { spawn } from 'node:child_process';
import { resolveApiEngine, resolveCliEngine } from '@tent-nocode/kernel';

// Engine credential flow: probe-validate a key, then store it in the vault. The value never logs or echoes into an error.

/** The vault as this flow needs it - presence is names alone, no readback. */
export interface EngineVault {
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  names(): Promise<string[]>;
}

export interface EngineCredentialDeps {
  /** Validate a credential; returns ok or a sanitized error with the value scrubbed. */
  probe: (envVar: string, value: string) => Promise<{ ok: boolean; error: string | null }>;
}

export interface SaveEngineCredentialInput {
  engineId: string;
  kind: string;
  value: string;
}

export type SaveEngineCredentialResult = { validated: true } | { validated: false; error: string };

/** One engine's credential slots (CLI kinds or the API engine's single api-key slot); null = unknown engine. */
function credentialSlotsFor(engineId: string): Array<{ kind: string; vaultName: string; envVar: string | null; label: string }> | null {
  const cli = resolveCliEngine(engineId);
  if (cli !== null) {
    return cli.credentialKinds.map((k) => ({ kind: k.kind, vaultName: k.vaultName, envVar: k.envVar, label: k.label }));
  }
  const api = resolveApiEngine(engineId);
  if (api !== null) {
    // API engine slot is probed by a direct vendor ping, never a child process.
    return [{ kind: 'api-key', vaultName: api.vaultName, envVar: null, label: api.label }];
  }
  return null;
}

export async function saveEngineCredentialFlow(
  vault: EngineVault,
  deps: EngineCredentialDeps,
  input: SaveEngineCredentialInput,
): Promise<SaveEngineCredentialResult> {
  const slots = credentialSlotsFor(input.engineId);
  if (slots === null) return { validated: false, error: `unknown engine '${input.engineId}'` };
  const kindSpec = slots.find((k) => k.kind === input.kind);
  if (kindSpec === undefined) return { validated: false, error: `unknown credential kind '${input.kind}'` };
  const value = input.value.trim();
  if (value === '') return { validated: false, error: 'the credential is empty' };
  const probed = await deps.probe(kindSpec.envVar ?? '', value);
  if (!probed.ok) return { validated: false, error: probed.error ?? 'the credential failed validation' };
  await vault.set(kindSpec.vaultName, value);
  return { validated: true };
}

export async function removeEngineCredentialFlow(
  vault: EngineVault,
  input: { engineId: string; kind: string },
): Promise<void> {
  const kindSpec = credentialSlotsFor(input.engineId)?.find((k) => k.kind === input.kind);
  if (kindSpec === undefined) throw new Error(`unknown engine credential '${input.engineId}/${input.kind}'`);
  await vault.remove(kindSpec.vaultName);
}

export interface EngineStatusResult {
  engineId: string;
  displayName: string;
  lane: 'cli' | 'api';
  installHint: string;
  /** null = binary not detected on PATH (the installHint renders). API lane: always null. */
  binaryVersion: string | null;
  kinds: Array<{ kind: string; label: string; present: boolean; placeholder?: string }>;
}

/** Fast status read: cached version probe plus vault name presence; never a model call. */
export async function engineStatusRead(
  vault: EngineVault,
  engineId: string,
  versionProbe: (binary: string) => Promise<string | null>,
): Promise<EngineStatusResult | null> {
  const names = await vault.names().catch(() => [] as string[]);
  const engine = resolveCliEngine(engineId);
  if (engine !== null) {
    const kinds = engine.credentialKinds.map((k) => ({
      kind: k.kind, label: k.label, present: names.includes(k.vaultName),
    }));
    return {
      engineId: engine.id,
      displayName: engine.displayName,
      lane: 'cli',
      installHint: engine.installHint,
      binaryVersion: await versionProbe(engine.binary),
      kinds,
    };
  }
  const api = resolveApiEngine(engineId);
  if (api === null) return null;
  return {
    engineId: api.id,
    displayName: api.displayName,
    lane: 'api',
    installHint: '',
    binaryVersion: null,
    kinds: [{ kind: 'api-key', label: api.label, present: names.includes(api.vaultName), placeholder: api.keyPlaceholder }],
  };
}

// ---------------------------------------------------------------------------
// The real probes (spawn the CLI; Windows needs shell resolution for .cmd).

const scrub = (text: string, value: string): string =>
  value.length > 0 ? text.split(value).join('[credential]') : text;

/** Cheap `--version` detection; cached by the handler per boot. */
export function probeBinaryVersion(binary: string, versionArgs: string[]): Promise<string | null> {
  return new Promise((resolveP) => {
    let out = '';
    const child = spawn(binary, versionArgs, { shell: true, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolveP(null); }, 15_000);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolveP(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP(code === 0 && out.trim() !== '' ? (out.trim().split(/\r?\n/)[0] ?? null) : null);
    });
  });
}

/** API-key validation: one cheap read against the vendor's models endpoint; the key goes to its own vendor only. */
export function makeApiKeyProbe(engineId: string) {
  return async (_envVar: string, value: string): Promise<{ ok: boolean; error: string | null }> => {
    const engine = resolveApiEngine(engineId);
    if (engine === null) return { ok: false, error: 'unknown engine' };
    const url = engine.vendor === 'anthropic'
      ? `https://${engine.upstreamHost}/v1/models?limit=1`
      : `https://${engine.upstreamHost}/v1/models`;
    const headers: Record<string, string> = engine.vendor === 'anthropic'
      ? { 'x-api-key': value, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${value}` };
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return { ok: true, error: null };
      let detail = `the ${engine.displayName} API refused the key (HTTP ${res.status})`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (typeof body.error?.message === 'string' && body.error.message.length > 0) {
          detail = body.error.message.slice(0, 300);
        }
      } catch { /* keep the status sentence */ }
      return { ok: false, error: scrub(detail, value) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrub(`could not reach ${engine.upstreamHost}: ${msg}`.slice(0, 300), value) };
    }
  };
}

/** Runs the engine's CLI validation probe; envVar null probes the machine's inherited login. */
export function makeCredentialProbe(engineId: string) {
  return (envVar: string | null, value: string): Promise<{ ok: boolean; error: string | null }> =>
    new Promise((resolveP) => {
      const engine = resolveCliEngine(engineId);
      if (engine === null) { resolveP({ ok: false, error: 'unknown engine' }); return; }
      const probeSpec = engine.validationProbe;
      const args = ['-p', JSON.stringify(probeSpec.prompt)];
      if (probeSpec.model !== undefined) args.push('--model', probeSpec.model);
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (envVar !== null) env[envVar] = value;
      let out = '';
      let err = '';
      const child = spawn(engine.binary, args, { shell: true, windowsHide: true, env });
      const timer = setTimeout(() => {
        child.kill();
        resolveP({ ok: false, error: 'the validation probe timed out (90s) — check your network and try again' });
      }, 90_000);
      child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); resolveP({ ok: false, error: scrub(e.message, value) }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.includes(probeSpec.expect)) { resolveP({ ok: true, error: null }); return; }
        const tail = (err.trim() || out.trim()).split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
        resolveP({ ok: false, error: scrub(tail === '' ? `the engine exited ${code ?? 'abnormally'}` : tail, value) });
      });
    });
}
