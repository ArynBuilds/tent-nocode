// Replaces secret values in text with [REDACTED]; values under 4 characters are skipped.

export const REDACTED = '[REDACTED]';

export function redactSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value.length < 4) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

/** True when redaction changed anything - the caller's cue to land the record event. */
export function containsSecretValue(text: string, values: readonly string[]): boolean {
  return values.some((v) => v.length >= 4 && text.includes(v));
}
