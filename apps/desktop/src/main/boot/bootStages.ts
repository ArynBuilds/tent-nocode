// All user-facing boot sentences and failure classification live here; the raw error only reaches Show-details and boot.log.

export type BootStageKind = 'starting-db' | 'first-time-setup' | 'finishing' | 'ready';

export type BootFailureKind = 'unknown';

export interface BootFailure {
  kind: BootFailureKind;
  /** Plain-words sentence shown to the user. */
  sentence: string;
  /** The one action offered beside Quit. */
  action: 'try-again';
  /** The raw error, for Show-details and boot.log. */
  detail: string;
}

export const BOOT_STAGE_SENTENCES: Record<BootStageKind, string> = {
  'starting-db': 'Getting things ready…',
  'first-time-setup': 'Getting things ready…',
  finishing: 'Almost there…',
  ready: '',
};

export function stageSentence(stage: BootStageKind): string {
  return BOOT_STAGE_SENTENCES[stage];
}

/** Maps a boot-fatal error to its failure sentence. */
export function classifyBootFailure(err: unknown): BootFailure {
  const detail = err instanceof Error
    ? `${err.name}: ${err.message}`
    : (() => { try { return `non-Error throw: ${JSON.stringify(err) ?? String(err)}`; } catch { return `non-Error throw: ${String(err)}`; } })();
  return {
    kind: 'unknown',
    sentence: err instanceof Error && err.name === 'PortBusyError'
      ? err.message
      : "Tent NoCode couldn't start. Nothing was lost - your work stays on this computer.",
    action: 'try-again',
    detail,
  };
}
