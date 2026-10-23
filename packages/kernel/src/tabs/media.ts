import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type postgres from 'postgres';
import { findActiveFolderGrant } from '../consent.js';

// Resolves a tab's media binding against live folder grants; rows carry relative names only — the tab never sees an absolute path.

const MAX_MEDIA_FILES = 200;

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

export interface MediaFile {
  /** Path relative to the binding's folder, forward slashes. */
  file: string;
  bytes: number;
  mime: string;
  /** Host-side absolute path for the desktop mount map only; never fed to a tab. */
  absPath: string;
}

/** Minimal anchored glob: `*` = any run within a segment, `**` = any depth. */
export function globToRegExp(glob: string): RegExp {
  // Sentinels are runtime-constructed; `**/` matches zero or more directories.
  const DEEP_SLASH = String.fromCharCode(1);
  const DEEP = String.fromCharCode(2);
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DEEP_SLASH)
    .replace(/\*\*/g, DEEP)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(DEEP_SLASH, 'g'), '(?:.*/)?')
    .replace(new RegExp(DEEP, 'g'), '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export async function resolveMediaFiles(
  sql: postgres.Sql,
  input: { orgId: string; folder: string; select: string },
): Promise<{ files: MediaFile[]; notice: string | null }> {
  const grant = await findActiveFolderGrant(sql, input.orgId, input.folder);
  if (!grant) {
    return { files: [], notice: `folder '${input.folder}' has no live grant — media renders nothing (grant the folder or revise the tab)` };
  }
  const re = globToRegExp(input.select);
  const files: MediaFile[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_MEDIA_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_MEDIA_FILES) return;
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue;
        walk(abs);
        continue;
      }
      const rel = relative(input.folder, abs).split(sep).join('/');
      const ext = entry.includes('.') ? entry.slice(entry.lastIndexOf('.') + 1).toLowerCase() : '';
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue; // media files only — this channel streams media, not source trees
      if (!re.test(rel)) continue;
      files.push({ file: rel, bytes: st.size, mime, absPath: abs });
    }
  };
  walk(input.folder);
  const notice = files.length >= MAX_MEDIA_FILES
    ? `showing the first ${MAX_MEDIA_FILES} files — narrow the select glob for the rest`
    : null;
  return { files, notice };
}
