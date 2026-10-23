/**
 * THE ENGINE BUILD: builds packages/tentkit into ONE browser file named by its content hash,
 * apps/desktop/resources/engines/tentkit-<hash>.js, beside the manifest tentkit.json
 * ({file, sha256, integrity, size}) both hosts read to serve it. Stale tentkit-*.js files in
 * the engines dir are removed. The output is generated, never checked in.
 *
 *   npx tsx scripts/build-tentkit.mts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const enginesDir = join(root, 'apps', 'desktop', 'resources', 'engines');

export interface TentkitBuildRecord {
  format: 'tentkit-build@1';
  file: string;
  sha256: string;
  /** ssri's shape: sha512-<base64>. */
  integrity: string;
  size: number;
  version: string;
  builtAt: string;
}

async function buildTentkit(): Promise<TentkitBuildRecord> {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', 'tentkit', 'package.json'), 'utf8')) as { version: string };
  const out = await build({
    entryPoints: [join(root, 'packages', 'tentkit', 'src', 'tentkit.tsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'Tentkit',
    target: ['es2020'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const file = out.outputFiles[0];
  if (file === undefined) throw new Error('esbuild produced no output');
  const bytes = Buffer.from(file.contents);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const name = `tentkit-${sha256.slice(0, 16)}.js`;
  mkdirSync(enginesDir, { recursive: true });
  for (const entry of readdirSync(enginesDir)) {
    if (/^tentkit-[0-9a-f]{16}\.js$/.test(entry) && entry !== name) unlinkSync(join(enginesDir, entry));
  }
  writeFileSync(join(enginesDir, name), bytes);
  const record: TentkitBuildRecord = {
    format: 'tentkit-build@1', file: name, sha256, integrity, size: bytes.length, version: pkg.version, builtAt: new Date().toISOString(),
  };
  writeFileSync(join(enginesDir, 'tentkit.json'), JSON.stringify(record, null, 2));
  console.log(`[tentkit] ${name} (${(bytes.length / 1024).toFixed(1)} KB, ${integrity.slice(0, 20)}…)`);
  return record;
}


await buildTentkit();
