// The declarative model registry: one data row per API model; adding a model is a row, never code.

export type ModelVendor = 'anthropic' | 'openai';

export interface ModelEntry {
  /** The stable pick id the org pin stores; same as the wire id by convention. */
  id: string;
  /** Human display name; the picker renders this alone. */
  display: string;
  vendor: ModelVendor;
  /** The provider-side model id sent on the wire. */
  wireId: string;
  /** Prompt-caching posture: 'breakpoints' = explicit markers; 'automatic' = provider-side. */
  caching: 'breakpoints' | 'automatic';
}

// Claude is the default; the charters and guides were tuned on it.
export const DEFAULT_MODEL_ID = 'claude-sonnet-5';

export const MODEL_REGISTRY: Readonly<Record<string, ModelEntry>> = Object.freeze({
  'claude-sonnet-5': {
    id: 'claude-sonnet-5', display: 'Claude Sonnet 5',
    vendor: 'anthropic', wireId: 'claude-sonnet-5', caching: 'breakpoints',
  },
  'claude-opus-5': {
    id: 'claude-opus-5', display: 'Claude Opus 5',
    vendor: 'anthropic', wireId: 'claude-opus-5', caching: 'breakpoints',
  },
  'claude-fable-5': {
    id: 'claude-fable-5', display: 'Claude Fable 5',
    vendor: 'anthropic', wireId: 'claude-fable-5', caching: 'breakpoints',
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5', display: 'Claude Haiku 4.5',
    vendor: 'anthropic', wireId: 'claude-haiku-4-5', caching: 'breakpoints',
  },
  'gpt-5.4': {
    id: 'gpt-5.4', display: 'GPT-5.4',
    vendor: 'openai', wireId: 'gpt-5.4', caching: 'automatic',
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini', display: 'GPT-5.4 Mini',
    vendor: 'openai', wireId: 'gpt-5.4-mini', caching: 'automatic',
  },
  'gpt-5.2-pro': {
    id: 'gpt-5.2-pro', display: 'GPT-5.2 Pro',
    vendor: 'openai', wireId: 'gpt-5.2-pro', caching: 'automatic',
  },
  'gpt-5.1': {
    id: 'gpt-5.1', display: 'GPT-5.1',
    vendor: 'openai', wireId: 'gpt-5.1', caching: 'automatic',
  },
});

/** Returns the registry entry, or null when the id is not a registry pick; never throws. */
export function resolveRegistryModel(id: string | null | undefined): ModelEntry | null {
  if (id === null || id === undefined || id === '') return MODEL_REGISTRY[DEFAULT_MODEL_ID] ?? null;
  return MODEL_REGISTRY[id] ?? null;
}

/** The picker's rows, in registry order. */
export function listRegistryModels(): ModelEntry[] {
  return Object.values(MODEL_REGISTRY);
}
