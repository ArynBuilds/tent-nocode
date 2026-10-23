import { importFormatFor } from '@tent-nocode/core';

// Parses every launch payload: --focus-scene=<slug> and positional import files.
// Flags are never trusted as payloads; import suffixes come from the import registry.

export interface LaunchArgs {
  focusSlug: string | null;
  packagePath: string | null;
}

const FOCUS_RE = /^--focus-scene=(.+)$/;

export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  let focusSlug: string | null = null;
  let packagePath: string | null = null;
  for (const arg of argv) {
    const focus = FOCUS_RE.exec(arg);
    if (focus && focus[1]) {
      focusSlug = focus[1];
      continue;
    }
    if (arg.startsWith('--')) continue; // Chromium-injected or unknown flags
    if (importFormatFor(arg)?.argv === true) {
      packagePath = arg;
      continue;
    }
  }
  return { focusSlug, packagePath };
}
