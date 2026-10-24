import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import {
  DEFAULT_MODEL_ID, MODEL_REGISTRY, listRegistryModels, resolveRegistryModel,
  type ModelEntry,
} from '@nodeloom/core';
import { apiEngineForVendor } from '@nodeloom/kernel';

// Turns a model registry row into a live vendor adapter; the apiKey is consumed in-process only.

export { DEFAULT_MODEL_ID, MODEL_REGISTRY, listRegistryModels, resolveRegistryModel };
export type { ModelEntry };

/** The vendor adapter for one registry row, via the vendor's official provider package. */
export function languageModelFor(entry: ModelEntry, apiKey: string): LanguageModel {
  if (entry.vendor === 'anthropic') {
    return createAnthropic({ apiKey })(entry.wireId);
  }
  return createOpenAI({ apiKey })(entry.wireId);
}

/** The vault slot holding this row's vendor key. */
export function vaultNameFor(entry: ModelEntry): string {
  return apiEngineForVendor(entry.vendor).vaultName;
}
