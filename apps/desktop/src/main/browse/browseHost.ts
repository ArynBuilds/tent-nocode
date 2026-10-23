import { BrowserWindow, session } from 'electron';

// Walled browser host: each run gets a hidden sandboxed BrowserWindow on an in-memory session, navigation gated by its granted domains.

interface Cage { win: BrowserWindow; allowed: Set<string>; }

const cages = new Map<string, Cage>();
// Authoritative per-run allowlist, set by the runner in main; never caller-supplied.
const grants = new Map<string, Set<string>>();

/** Register a run's granted browse domains (called by the runner at mount, in main). */
export function setBrowseGrant(runId: string, domains: string[]): void {
  grants.set(runId, new Set(domains));
}

/** Release a run's grant + cage (called by the runner when the run settles). */
export function releaseBrowse(runId: string): void {
  grants.delete(runId);
  teardown(runId);
}

function hostAllowed(allowed: Set<string>, url: string): boolean {
  // Scheme-locked to http/https; hostname must be an exact grant match.
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && allowed.has(u.hostname);
  } catch { return false; }
}

function makeCage(runId: string, allowed: Set<string>): Cage {
  const partition = `browse:${runId}`; // no 'persist:' prefix ⇒ in-memory session
  const ses = session.fromPartition(partition);
  ses.on('will-download', (e) => e.preventDefault());
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!hostAllowed(allowed, url)) e.preventDefault(); });
  win.webContents.on('will-redirect', (e, url) => { if (!hostAllowed(allowed, url)) e.preventDefault(); });
  const cage: Cage = { win, allowed };
  cages.set(runId, cage);
  return cage;
}

/** Navigates the run's cage to a granted URL and returns the page's readable text plus byte length. */
export async function navigate(
  runId: string, url: string,
): Promise<{ text: string; contentBytes: number }> {
  const allowed = grants.get(runId);
  if (!allowed) throw new Error('browse refused: this run has no registered browse grant');
  if (!hostAllowed(allowed, url)) {
    throw new Error(`browse refused: ${(() => { try { return new URL(url).hostname; } catch { return url; } })()} is not a granted domain`);
  }
  const cage = cages.get(runId) ?? makeCage(runId, allowed);
  cage.allowed = allowed;
  await cage.win.loadURL(url);
  const text = String(await cage.win.webContents.executeJavaScript('document.body?.innerText ?? ""'));
  return { text, contentBytes: Buffer.byteLength(text, 'utf8') };
}

/** Tear down a run's cage (called when the run settles; also safe to call for an unknown run). */
export function teardown(runId: string): void {
  const cage = cages.get(runId);
  if (!cage) return;
  cages.delete(runId);
  if (!cage.win.isDestroyed()) cage.win.destroy();
}
