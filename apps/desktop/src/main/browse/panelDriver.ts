import { session, webContents } from 'electron';
import { workspaceCall } from '../workspaceClient.js';
import {
  acquireLease, handBackLease, leaseGuard, leaseInfo, releaseLease, resumeLease,
  revokeLease, setLeaseEmitter, type PanelLease,
} from './panelLease.js';

// Visible-browser driver: drives the side panel's user browser tab under a single-holder lease; verbs refuse without one, password typing refuses, downloads block while leased, every action is recorded.

const PAGE_TEXT_MAX = 6000;
const INTERACTABLES_MAX = 120;
const LOAD_TIMEOUT_MS = 15_000;
const GUEST_WAIT_MS = 5_000;

let guestId: number | null = null;

function record(type: string, payload: Record<string, unknown>): void {
  // Telemetry rides the workspace wall and never fails a drive.
  void workspaceCall('runner.emitEvent', [{ actor: 'kernel.panelbrowser', type, payload }]).catch(() => {});
}

/** The panel webview reports its webContentsId on dom-ready, null on unmount; a vanishing guest revokes a live lease. */
export function setPanelGuest(id: number | null): void {
  guestId = id;
  if (id === null) revokeLease('browser tab closed');
}

export function panelLeaseInfo(): PanelLease | null {
  return leaseInfo();
}

/** Consent already happened upstream before this runs. */
export function acquirePanelLease(runId: string, orgId: string, task: string): { ok: true } | { ok: false; error: string } {
  return acquireLease(runId, orgId, task);
}

export function releasePanelLease(runId: string): void {
  releaseLease(runId);
}

/** User-side revoke; revoked stays revoked. */
export function revokePanelLease(reason: string): void {
  revokeLease(reason);
}

/** The holder hands the wheel to the user (credentials, payments, challenges). */
export function handBackPanelLease(runId: string, reason: string): { ok: true } | { ok: false; error: string } {
  return handBackLease(runId, reason);
}

/** Only the user resumes, never the agent. */
export function resumePanelLease(): void {
  resumeLease();
}

/** Blocks downloads while a lease is live and wires lease events to the record. */
export function initPanelDriver(): void {
  setLeaseEmitter(record);
  session.fromPartition('persist:userbrowse').on('will-download', (e) => {
    if (leaseInfo() !== null) e.preventDefault();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function guestFor(runId: string): Promise<Electron.WebContents> {
  const refusal = leaseGuard(runId);
  if (refusal !== null) throw new Error(refusal);
  const deadline = Date.now() + GUEST_WAIT_MS;
  while (Date.now() < deadline) {
    if (guestId !== null) {
      const wc = webContents.fromId(guestId);
      if (wc && !wc.isDestroyed()) return wc;
    }
    await sleep(250);
  }
  throw new Error('the browser tab is not ready — is the side panel open?');
}

async function waitForQuiet(wc: Electron.WebContents, timeoutMs: number): Promise<void> {
  if (!wc.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done(): void {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    }
    wc.on('did-stop-loading', done);
  });
}

export async function panelOpen(runId: string, url: string): Promise<{ url: string; title: string }> {
  const wc = await guestFor(runId);
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  record('browser.action', { runId, action: 'open', target });
  try {
    await wc.loadURL(target);
  } catch {
    /* ERR_ABORTED fires on in-page redirects — the page state below is the truth */
  }
  await waitForQuiet(wc, LOAD_TIMEOUT_MS);
  return { url: wc.getURL(), title: wc.getTitle() };
}

/** The digest tags interactables with data-agx indexes so click({index}) is stable. */
const READ_SCRIPT = `(() => {
  const els = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"]'))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .slice(0, ${INTERACTABLES_MAX});
  els.forEach((e, i) => e.setAttribute('data-agx', String(i)));
  const line = (e, i) => {
    const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const kind = e.tagName.toLowerCase() + (e.type ? ':' + e.type : '');
    return '[' + i + '] <' + kind + '> ' + t;
  };
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, ${PAGE_TEXT_MAX}) : '',
    interactables: els.map(line),
  });
})()`;

export async function panelReadPage(runId: string): Promise<string> {
  const wc = await guestFor(runId);
  record('browser.action', { runId, action: 'read_page', target: wc.getURL() });
  return (await wc.executeJavaScript(READ_SCRIPT, true)) as string;
}

export async function panelScreenshot(runId: string): Promise<{ mime: string; base64: string }> {
  const wc = await guestFor(runId);
  record('browser.action', { runId, action: 'screenshot', target: wc.getURL() });
  let image = await wc.capturePage();
  const size = image.getSize();
  if (size.width > 1024) image = image.resize({ width: 1024 });
  return { mime: 'image/jpeg', base64: image.toJPEG(70).toString('base64') };
}

export async function panelClick(
  runId: string, target: { selector?: string; index?: number; x?: number; y?: number },
): Promise<string> {
  const wc = await guestFor(runId);
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    record('browser.action', { runId, action: 'click', target: `@${target.x},${target.y}` });
    wc.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await waitForQuiet(wc, LOAD_TIMEOUT_MS);
    return 'clicked';
  }
  const sel = typeof target.index === 'number' ? `[data-agx="${target.index}"]` : target.selector;
  if (sel === undefined || sel === '') throw new Error('click needs a selector, an index from read_page, or x/y');
  record('browser.action', { runId, action: 'click', target: sel });
  const result = (await wc.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'notfound';
      el.scrollIntoView({ block: 'center' }); el.click(); return 'ok'; })()`,
    true,
  )) as string;
  if (result === 'notfound') throw new Error(`nothing matches ${sel} — read_page again, the page may have changed`);
  await waitForQuiet(wc, LOAD_TIMEOUT_MS);
  return 'clicked';
}

export async function panelType(
  runId: string, target: { selector?: string; index?: number }, text: string, submit: boolean,
): Promise<string> {
  const wc = await guestFor(runId);
  const sel = typeof target.index === 'number' ? `[data-agx="${target.index}"]` : target.selector;
  if (sel === undefined || sel === '') throw new Error('type_text needs a selector or an index from read_page');
  const state = (await wc.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'notfound';
      el.scrollIntoView({ block: 'center' }); el.focus();
      if ((el.type || '') === 'password') return 'password';
      if (el.select) { try { el.select(); } catch {} }
      return 'ok'; })()`,
    true,
  )) as string;
  if (state === 'notfound') throw new Error(`nothing matches ${sel} — read_page again, the page may have changed`);
  if (state === 'password') {
    throw new Error('that is a password field — call hand_back so the user can enter it themselves');
  }
  record('browser.action', { runId, action: 'type', target: sel });
  wc.insertText(text);
  if (submit) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'char', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await waitForQuiet(wc, LOAD_TIMEOUT_MS);
  }
  return 'typed';
}

export async function panelScroll(runId: string, dy: number): Promise<string> {
  const wc = await guestFor(runId);
  record('browser.action', { runId, action: 'scroll', target: String(dy) });
  await wc.executeJavaScript(`window.scrollBy(0, ${Math.trunc(dy)})`, true);
  return 'scrolled';
}

export async function panelWait(runId: string, ms: number): Promise<string> {
  await guestFor(runId);
  await sleep(Math.min(Math.max(ms, 0), 10_000));
  return 'waited';
}
