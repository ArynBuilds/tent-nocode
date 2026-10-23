/** Scrubs secret values from text bound for the record; the length floor keeps a short value from shredding prose. */
export function scrubSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length >= 8) out = out.split(v).join('[credential]');
  }
  return out;
}
