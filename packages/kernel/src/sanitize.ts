/** Strips control chars, ANSI escapes, and newlines from stored text so it cannot inject into rendered context. */
export function sanitizeLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // eslint-disable-next-line no-control-regex
  const noControl = noAnsi.replace(/[\x00-\x1f\x7f]/g, ' ');
  return noControl.replace(/\s+/g, ' ').trim();
}
