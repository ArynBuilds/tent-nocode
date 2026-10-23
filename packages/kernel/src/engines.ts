// Closed CLI-engine registry: declares credentials, probes, and hosts; the driver consumes. No user-defined engines.

export interface EngineCredentialKind {
  kind: 'subscription-token' | 'api-key';
  /** Reserved vault name holding this credential. */
  vaultName: string;
  /** The env var the engine understands; consumed by the driver at spawn, never the kernel. */
  envVar: string;
  label: string;
}

export interface CliEngineEntry {
  id: string;
  displayName: string;
  /** CLI binary name resolved on PATH; the app detects engines, never installs them. */
  binary: string;
  /** Precedence-ordered: the first kind with a vault value wins at spawn. */
  credentialKinds: EngineCredentialKind[];
  /** argv for a cheap version probe. */
  versionProbeArgs: string[];
  /** Probe intent for credential validation; the driver composes the invocation. */
  validationProbe: { prompt: string; expect: string; model?: string };
  /** What to tell the user when the binary is absent. */
  installHint: string;
  /** The engine's API host; the credential proxy's host-locked upstream. */
  upstreamHost: string;
  /** Env var that redirects the engine's API traffic to a base URL. */
  baseUrlEnvVar: string;
}

export const ENGINE_VAULT_PREFIX = 'ENGINE_';

// True for vault names the engine credential flows own; the generic secrets surface refuses and hides these.
export function isEngineReservedSecretName(name: string): boolean {
  return name.toUpperCase().startsWith(ENGINE_VAULT_PREFIX);
}

export const CLI_ENGINE_REGISTRY: Record<string, CliEngineEntry> = Object.freeze({
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    credentialKinds: [
      {
        kind: 'subscription-token',
        vaultName: 'ENGINE_CLAUDE_OAUTH_TOKEN',
        envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
        label: 'Claude subscription (setup-token)',
      },
      {
        kind: 'api-key',
        vaultName: 'ENGINE_CLAUDE_API_KEY',
        envVar: 'ANTHROPIC_API_KEY',
        label: 'Anthropic API key',
      },
    ],
    versionProbeArgs: ['--version'],
    validationProbe: { prompt: 'Reply with exactly: OK', expect: 'OK', model: 'claude-haiku-4-5-20251001' },
    installHint:
      'Claude Code is not installed. Install it first (npm install -g @anthropic-ai/claude-code, or see claude.com/claude-code), then relaunch Tent NoCode.',
    upstreamHost: 'api.anthropic.com',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
  },
});

export function resolveCliEngine(id: string): CliEngineEntry | null {
  return CLI_ENGINE_REGISTRY[id] ?? null;
}

// API-engine registry: the two direct-API lanes; no binary, the key meets requests inside the driver alone.

export interface ApiEngineEntry {
  id: string;
  displayName: string;
  vendor: 'anthropic' | 'openai';
  /** Reserved vault name holding this vendor's API key. */
  vaultName: string;
  label: string;
  /** The vendor's API host; the validation ping's only destination. */
  upstreamHost: string;
  /** Input placeholder for the key field. */
  keyPlaceholder: string;
}

export const API_ENGINE_REGISTRY: Record<string, ApiEngineEntry> = Object.freeze({
  'anthropic-api': {
    id: 'anthropic-api',
    displayName: 'Claude (API)',
    vendor: 'anthropic',
    vaultName: 'ENGINE_CLAUDE_API_KEY',
    label: 'Anthropic API key',
    upstreamHost: 'api.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
  },
  'openai-api': {
    id: 'openai-api',
    displayName: 'ChatGPT (API)',
    vendor: 'openai',
    vaultName: 'ENGINE_OPENAI_API_KEY',
    label: 'OpenAI API key',
    upstreamHost: 'api.openai.com',
    keyPlaceholder: 'sk-…',
  },
});

export function resolveApiEngine(id: string): ApiEngineEntry | null {
  return API_ENGINE_REGISTRY[id] ?? null;
}

// The vendor's API engine row; the model registry routes by vendor.
export function apiEngineForVendor(vendor: 'anthropic' | 'openai'): ApiEngineEntry {
  const entry = Object.values(API_ENGINE_REGISTRY).find((e) => e.vendor === vendor);
  if (entry === undefined) throw new Error(`no API engine registered for vendor '${vendor}'`);
  return entry;
}

// Every engine the settings surface lists: the API engines and Claude Code (detected on the machine, never installed).
export function listedEngineIds(): string[] {
  return [...Object.keys(API_ENGINE_REGISTRY), ...Object.keys(CLI_ENGINE_REGISTRY)];
}
