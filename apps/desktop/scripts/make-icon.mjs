// The window/taskbar and .tproject icon generator. THE MARK is the one logo
// file, src/renderer/assets/nodeloom-logo.svg, rasterized by Playwright's Chromium
// (a desktop dev dependency) - no second copy of the geometry lives here.
//
// Modes:
//   node scripts/make-icon.mjs            → resources/icon.png (256², the window/taskbar face)
//   node scripts/make-icon.mjs --preview  → resources/icon-preview.png (dark plate composite)
//   node scripts/make-icon.mjs --ico      → build/icon.ico + build/tproject.ico
//     (multi-size ICO with PNG-compressed entries; the tproject glyph is the
//      same mark on a document page.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const TILE = '#f4f4f2';
// Every black face of the logo rides #1b1b1b, the site's own text ink.
const INK = '#1b1b1b';
// The mark's outer corner radius as a share of its width (130.13 / 731.03).
const MARK_RADIUS = 0.178;

const here = dirname(fileURLToPath(import.meta.url));
const MARK_SVG = readFileSync(join(here, '..', 'src', 'renderer', 'assets', 'nodeloom-logo.svg'), 'utf8')
  .replace(/<\?xml[^>]*\?>/, '')
  .replaceAll('#000000', INK);

/** The mark `w` units wide (256-space) at (x, y), its inside filled with the tile. */
function markAt(x, y, w) {
  const inset = w * 0.04;
  return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${w}px">
    <div style="position:absolute;inset:${inset}px;border-radius:${w * MARK_RADIUS}px;background:${TILE}"></div>
    <div style="position:absolute;inset:0">${MARK_SVG.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
  </div>`;
}

/** The app face: the mark on the rounded tile. */
function appFace({ preview = false } = {}) {
  const plate = preview ? '<div style="position:absolute;inset:0;border-radius:24px;background:#1a1a1a"></div>' : '';
  return `${plate}<div style="position:absolute;inset:4px;border-radius:56px;background:${TILE}"></div>${markAt(40, 40, 176)}`;
}

/** The .tproject association face: the mark, smaller and lower, on a portrait
 * document page with a fold line. */
function docFace() {
  return `<div style="position:absolute;left:44px;top:8px;width:168px;height:240px;border-radius:18px;background:${TILE}"></div>
    <div style="position:absolute;left:60px;top:36px;width:112px;height:9px;border-radius:5px;background:${INK}"></div>
    ${markAt(68, 92, 120)}`;
}

async function render(page, body, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:relative;width:256px;height:256px;transform:scale(${size / 256});transform-origin:0 0">${body}</div>
  </body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** ICO container with PNG-compressed entries (Vista+; electron-builder requires ≥256). */
function encodeIco(entries /* [{size, png}] */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size; // 0 means 256
    d[1] = size >= 256 ? 0 : size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4);   // planes
    d.writeUInt16LE(32, 6);  // bit count
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(d);
    blobs.push(png);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

const ICO_SIZES = [256, 64, 48, 32, 16];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  if (process.argv.includes('--ico')) {
    const buildDir = join(here, '..', 'build');
    mkdirSync(buildDir, { recursive: true });
    for (const [file, face] of [['icon.ico', appFace()], ['tproject.ico', docFace()]]) {
      const entries = [];
      for (const size of ICO_SIZES) entries.push({ size, png: await render(page, face, size) });
      const ico = encodeIco(entries);
      writeFileSync(join(buildDir, file), ico);
      console.log(`wrote ${join(buildDir, file)} (${ico.length} bytes)`);
    }
  } else {
    const preview = process.argv.includes('--preview');
    const png = await render(page, appFace({ preview }), 256);
    const dest = join(here, '..', 'resources', preview ? 'icon-preview.png' : 'icon.png');
    writeFileSync(dest, png);
    console.log(`wrote ${dest} (${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
