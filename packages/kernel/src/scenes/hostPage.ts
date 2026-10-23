import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectTheme } from '../projects.js';

// THE SCENE HOST PAGE (Phase 12, rows 12.7 and 12.8): one pure composer both hosts serve - the desktop's
// tab:// scheme and the fleet's room. The page loads the tentkit BUILD (one file named by its content
// hash, read from the engines dir's manifest and served only when its bytes still hash to the record -
// pacote's integrity shape) and receives document + data through the one typed port message the engine
// speaks. No inline shims: the engine measures, hits and feeds itself.

/** The served CSP: no connect-src by default; script-src allows the build's origin (and the room feeder, inline, until wave C). */
export function buildSceneFrameCsp(assetSrc: string): string {
  return `default-src 'none'; script-src 'unsafe-inline' ${assetSrc}; style-src 'unsafe-inline' ${assetSrc}; font-src ${assetSrc}; img-src data: https: ${assetSrc}; media-src https: ${assetSrc};`;
}

/** The desktop tab:// scheme's CSP (pinned bytes). */
export const TAB_CSP = buildSceneFrameCsp('tab:');

/** The room's push route (wave C lands the route; the page's CSP names it now). */
export const ROOM_LIVE_ROUTE = '/data/live';

/** The room origin's cage: 'self' plus the live route's origin (the same origin). */
export const ROOM_SCENE_CSP = `${buildSceneFrameCsp("'self'")} connect-src 'self';`;

/** The only font files any host's fonts route serves. */
export const FONT_ALLOWLIST: ReadonlySet<string> = new Set([
  'Inter-Regular.woff2', 'Inter-Medium.woff2', 'Inter-SemiBold.woff2', 'Inter-Bold.woff2',
  'JetBrainsMono-Regular.woff2', 'JetBrainsMono-Medium.woff2', 'JetBrainsMono-Bold.woff2',
]);

/** The vendored font family names. */
export const VENDORED_FONT_FAMILIES: readonly string[] = ['Inter', 'JetBrains Mono'];

/** The canonical scene token values, served identically on every host; the app's theme never changes a scene pixel. */
export function buildTokensCss(assetBase: string): string {
  return `:root {
  --bg: #171717;
  --side: #212121;
  --panel: #2a2a2a;
  --panel2: #303030;
  --border: #3a3a3a;
  --border2: #4a4a4a;
  --t0: #ffffff;
  --t1: #ececec;
  --t2: #a0a0a0;
  --t3: #7a7a7a;
  --accent: #ececec;
  --green: #3fb950;
  --amber: #d29922;
  --red: #f85149;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
  --sans: 'Inter', system-ui, sans-serif;
  --r1: 10px;
  --r2: 14px;
  --r3: 18px;
  --fs-caption: 11px;
  --fs-small: 12px;
  --fs-body: 13px;
  --fs-title: 14px;
  --fs-heading: 16px;
  --fs-metric: 26px;
  --fs-hero: 40px;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --chart-grid: #2c2c2c;
  --chart-axis: #4a4a4a;
  --series-1: #d97757;
  --series-2: #8caec9;
  --series-3: #c9a84c;
  --series-4: #86b39c;
  --series-5: #a98fc0;
  --series-6: #97999e;
}
/* THE HUED SERIES RAMP (2026-07-26, user-directed — the T40 color fork's recorded
   exemption exercised: data series only, chrome stays MONOCHROME, status hues untouched.
   Final ratification is the user's, ON PIXELS; the mono ramp for instant revert:
   #ececec #b0b0b0 #858585 #616161 #474747 #383838 */
@font-face { font-family: 'Inter'; src: url('${assetBase}/assets/fonts/Inter-Regular.woff2') format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'Inter'; src: url('${assetBase}/assets/fonts/Inter-Medium.woff2') format('woff2'); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: 'Inter'; src: url('${assetBase}/assets/fonts/Inter-SemiBold.woff2') format('woff2'); font-weight: 600; font-style: normal; font-display: swap; }
@font-face { font-family: 'Inter'; src: url('${assetBase}/assets/fonts/Inter-Bold.woff2') format('woff2'); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: 'JetBrains Mono'; src: url('${assetBase}/assets/fonts/JetBrainsMono-Regular.woff2') format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'JetBrains Mono'; src: url('${assetBase}/assets/fonts/JetBrainsMono-Medium.woff2') format('woff2'); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: 'JetBrains Mono'; src: url('${assetBase}/assets/fonts/JetBrainsMono-Bold.woff2') format('woff2'); font-weight: 700; font-style: normal; font-display: swap; }
body { margin: 0; font-family: var(--sans); background: var(--bg); color: var(--t1); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background-color: rgba(154, 154, 154, 0.22); border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; min-height: 32px; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(154, 154, 154, 0.42); }
::-webkit-scrollbar-thumb:active { background-color: rgba(154, 154, 154, 0.55); }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
`;
}

/** The desktop tokens document (pinned bytes). */
export const TAB_TOKENS_CSS = buildTokensCss('tab://local');

/** One CSS value, fenced: no braces, semicolons or tag brackets can leave the declaration. */
function cssValue(v: string): string {
  return v.replace(/[;{}<>]/g, '').trim();
}

/** THE THEME REACHES EVERY PIXEL: the project's theme as one :root block injected after tokens.css - the
 * theme fields land on the vars the engine reads (--bg --side --panel --panel2 --border --border2
 * --t0..--t3 --accent --green --amber --red --r1..--r3 --sans --mono) and on the theme's own names (--card
 * --card-foreground --card-raised --primary --primary-foreground --accent-foreground --ring --glow --shadow);
 * every var the theme does not name keeps the tokens block's value. No theme = no block. */
export function buildThemeCss(theme: ProjectTheme | null | undefined): string {
  if (theme === null || theme === undefined) return '';
  const c = cssValue;
  const r = Math.max(0, Math.round(theme.radius));
  const font = (f: string, tail: string): string => `'${c(f).replace(/'/g, '')}', ${tail}`;
  const lines = [
    `--bg: ${c(theme.background)};`,
    `--background: ${c(theme.background)};`,
    `--side: ${c(theme.muted)};`,
    `--muted: ${c(theme.muted)};`,
    `--panel: ${c(theme.card)};`,
    `--card: ${c(theme.card)};`,
    `--card-foreground: ${c(theme.cardForeground)};`,
    `--panel2: ${c(theme.cardRaised)};`,
    `--card-raised: ${c(theme.cardRaised)};`,
    `--border: ${c(theme.border)};`,
    // The second border step: the border pulled a third of the way to the foreground.
    `--border2: color-mix(in srgb, ${c(theme.border)} 67%, ${c(theme.foreground)});`,
    `--t0: ${c(theme.foreground)};`,
    `--t1: ${c(theme.foreground)};`,
    `--foreground: ${c(theme.foreground)};`,
    `--t2: ${c(theme.mutedForeground)};`,
    `--muted-foreground: ${c(theme.mutedForeground)};`,
    // The quiet tier: the muted foreground pulled a third of the way to the ground.
    `--t3: color-mix(in srgb, ${c(theme.mutedForeground)} 67%, ${c(theme.background)});`,
    `--primary: ${c(theme.primary)};`,
    `--primary-foreground: ${c(theme.primaryForeground)};`,
    `--accent: ${c(theme.accent)};`,
    `--accent-foreground: ${c(theme.accentForeground)};`,
    `--ring: ${c(theme.ring)};`,
    `--green: ${c(theme.green)};`,
    `--amber: ${c(theme.amber)};`,
    `--red: ${c(theme.red)};`,
    // The radius ladder steps 4px per tier from the theme's radius (tokens: 10/14/18).
    `--r1: ${r}px;`,
    `--r2: ${r + 4}px;`,
    `--r3: ${r + 8}px;`,
    `--sans: ${font(theme.fontSans, 'system-ui, sans-serif')};`,
    `--mono: ${font(theme.fontMono, 'ui-monospace, monospace')};`,
    ...(theme.glow !== undefined ? [`--glow: ${c(theme.glow)};`] : []),
    ...(theme.shadow !== undefined ? [`--shadow: ${c(theme.shadow)};`] : []),
  ];
  return `:root {\n  ${lines.join('\n  ')}\n}\n`;
}

// ---------------------------------------------------------------------------
// The tentkit build: the manifest names the one file; the bytes serve only while they hash to it.
// ---------------------------------------------------------------------------

export const TENTKIT_MANIFEST = 'tentkit.json';
export const TENTKIT_FILE_RE = /^tentkit-([0-9a-f]{16})\.js$/;

export interface TentkitBuild {
  file: string;
  sha256: string;
  /** ssri's shape: sha512-<base64> - the value a release records. */
  integrity: string;
  size: number;
  version: string;
}

const buildCache = new Map<string, { at: number; build: TentkitBuild | null }>();
const BUILD_CACHE_MS = 5_000;

/** The build the engines dir carries, or null when no build has been made (the page then refuses, never a silent fallback). */
export async function readTentkitBuild(enginesDir: string): Promise<TentkitBuild | null> {
  const hit = buildCache.get(enginesDir);
  if (hit !== undefined && Date.now() - hit.at < BUILD_CACHE_MS) return hit.build;
  let build: TentkitBuild | null = null;
  try {
    const raw = JSON.parse(await readFile(join(enginesDir, TENTKIT_MANIFEST), 'utf8')) as Record<string, unknown>;
    if (typeof raw['file'] === 'string' && TENTKIT_FILE_RE.test(raw['file']) && typeof raw['sha256'] === 'string' && typeof raw['integrity'] === 'string') {
      build = {
        file: raw['file'], sha256: raw['sha256'], integrity: raw['integrity'],
        size: typeof raw['size'] === 'number' ? raw['size'] : 0, version: typeof raw['version'] === 'string' ? raw['version'] : '0',
      };
    }
  } catch {
    build = null;
  }
  buildCache.set(enginesDir, { at: Date.now(), build });
  return build;
}

/** Serves the build file only when the manifest names it and its bytes still hash to the recorded sha256. */
export async function serveTentkitBuild(enginesDir: string, fileName: string): Promise<Buffer | null> {
  if (!TENTKIT_FILE_RE.test(fileName)) return null;
  const build = await readTentkitBuild(enginesDir);
  if (build === null || build.file !== fileName) return null;
  try {
    const bytes = await readFile(join(enginesDir, fileName));
    const actual = createHash('sha256').update(bytes).digest('hex');
    return actual === build.sha256 ? bytes : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

/** The scene shape the composer consumes; both hosts pass it. */
export interface SceneServeInfo {
  title: string;
  /** The project's theme (getSceneForServe reads it); absent or null = the tokens block alone. */
  theme?: ProjectTheme | null;
}

export type ComposedScenePage =
  | { ok: true; html: string }
  | { ok: false; refusalHtml: string };

function escapeText(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** Composes the scene host page over the build; no build renders an explicit refusal, never a silent fallback. */
export function composeSceneHostPage(
  scene: SceneServeInfo,
  opts: {
    assetBase: string;
    /** The tentkit build the host's engines dir carries (readTentkitBuild). */
    build: Pick<TentkitBuild, 'file'> | null;
    /** 'edit' = the engine reports geometry and hits for the editor's chrome; 'serve' = the running app. */
    mode?: 'serve' | 'edit';
    /** Workspace ground color (#rrggbb): html/body paint it, the root clears - the frame cannot be truly transparent. */
    bareGround?: string;
    /** Extra HTML injected before </body>; the desktop never passes it. */
    extraBodyHtml?: string;
    /** Extra data attributes on the build's script tag (the room lane's app, scene, key, live route); the engine's boot reads them. */
    scriptData?: Record<string, string>;
    /** The app's title over the scene's; absent = the scene title. */
    title?: string;
    /** The theme's :root block (buildThemeCss); injected after tokens.css; empty = none. */
    themeCss?: string;
  },
): ComposedScenePage {
  const { assetBase } = opts;
  const head = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${assetBase}/assets/tokens.css">`;
  if (opts.build === null || !TENTKIT_FILE_RE.test(opts.build.file)) {
    const refusalHtml = `${head}</head><body><p style="padding:16px;color:var(--t2);font-size:13px;">this host carries no engine build - run <code>npm run build:tentkit</code> and reload</p></body></html>`;
    return { ok: false, refusalHtml };
  }
  // A bare mount is sized exactly to its element, so the bare serve zeroes root padding and hides overflow.
  const bareStyle = typeof opts.bareGround === 'string' && /^#[0-9a-f]{6}$/i.test(opts.bareGround)
    ? `<style>html,body{background:${opts.bareGround} !important;overflow:hidden}#scene,[data-node="root"]{background:transparent !important}#scene{padding:0 !important}</style>`
    : '';
  const html = head
    // The theme rides after the tokens so its vars win; every var it does not name keeps the tokens value.
    + (typeof opts.themeCss === 'string' && opts.themeCss.length > 0 ? `<style>${opts.themeCss}</style>` : '')
    + bareStyle
    + `<title>${escapeText(opts.title ?? scene.title)}</title>`
    + '</head><body><div id="scene"></div>'
    // The build mounts on #scene in the named mode and answers the port's 'init' with 'ready'.
    + `<script src="${assetBase}/engines/${opts.build.file}" data-mount="scene" data-mode="${opts.mode === 'edit' ? 'edit' : 'serve'}"${Object.entries(opts.scriptData ?? {}).map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`).join('')}></script>`
    + (opts.extraBodyHtml ?? '')
    + '</body></html>';
  return { ok: true, html };
}
