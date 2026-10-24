// The one registry of importable file formats; every surface reads this table.

export interface ImportFormat {
  /** lowercase extension, no dot */
  ext: string;
  lane: 'package' | 'rows';
  /** the plain word a surface may speak ("a Nodeloom project", "an Excel sheet") */
  word: string;
  /** may this format arrive as a positional OS-launch argument? */
  argv: boolean;
}

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  { ext: 'tproject', lane: 'package', word: 'a Nodeloom project', argv: true },
  // .lsg opens by drop only, never by OS launch.
  { ext: 'lsg', lane: 'package', word: 'a Nodeloom project', argv: false },
  { ext: 'xlsx', lane: 'rows', word: 'an Excel sheet', argv: false },
  { ext: 'csv', lane: 'rows', word: 'a CSV table', argv: false },
  { ext: 'tsv', lane: 'rows', word: 'a TSV table', argv: false },
] as const;

/** The row for a file name/path, or null when nothing imports it. */
export function importFormatFor(name: string): ImportFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return IMPORT_FORMATS.find((f) => f.ext === ext) ?? null;
}

/** Strip ANY registered import extension (the title/table-name derivation). */
export function stripImportExt(name: string): string {
  const fmt = importFormatFor(name);
  if (fmt === null) return name;
  return name.slice(0, name.length - fmt.ext.length - 1);
}

/** Regex matching package-lane extensions, derived from the registry. */
export function packageExtRe(): RegExp {
  const exts = IMPORT_FORMATS.filter((f) => f.lane === 'package').map((f) => f.ext);
  return new RegExp(`\\.(${exts.join('|')})$`, 'i');
}
