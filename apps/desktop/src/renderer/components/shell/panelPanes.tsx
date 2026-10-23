import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import type { InspectorSubject, NodeBrowseContext } from '../../lib/canvas/store.js';
import styles from './sidepanel.module.css';

/**
 * Tier 52 Phase 3: THE ONE TAB SYSTEM's panes — FilePane, BrowserPane and the
 * PanelTab shape, extracted VERBATIM from SidePanel.tsx (the 500-line law) so the bottom
 * panel hosts the same surfaces without duplicating a line. All original law accounting
 * (headers, lease strip, glass-pane wall) travels with the code unchanged.
 */

export interface PanelTab {
  id: string;
  /** THE RE-HOUSING R0: the slot registry widened — 'code' (the CodeScreen content as a
   * tab) and 'nodeBrowser' (§1.6 — content lands R2). 'browser' stays as CODE (ruling 8b:
   * entries hidden everywhere; the lease auto-open is the one opener left). */
  kind: 'browser' | 'file' | 'inspector' | 'workspace' | 'code' | 'nodeBrowser' | 'layers';
  /** Tier 35 (FR-363): file tabs — the absolute path the glass pane renders. */
  path?: string;
  /** Tier 38 (FR-386): inspector tabs — the subject (one inspector tab, updated in
   * place on every hit, the devtools idiom). R2: a CITIZEN may be the subject too. */
  selection?: InspectorSubject;
  /** R0: code tabs — the project whose Tools list scopes the editor; absent = org-wide. */
  projectId?: string;
  /** R2 (§1.6): node-browser tabs — the question + contract-filter context. */
  browse?: NodeBrowseContext;
}

let nextId = 1;
export function newTab(kind: PanelTab['kind'], path?: string, selection?: InspectorSubject): PanelTab {
  return { id: `pt${nextId++}`, kind, ...(path !== undefined ? { path } : {}), ...(selection !== undefined ? { selection } : {}) };
}

/**
 * Tier 35 (FR-363, D-139): THE GLASS PANE — a delivered file as a read-only tab. JetBrains
 * Mono, breadcrumbed path, an OS-reveal affordance; refreshes on a quiet poll so the user
 * watches the code land while a run writes (the change flashes by luminance — content
 * updates, never per-line hunks in v1: run.workspace_changes carries file lists, not diffs).
 * The read is walled main-side to the kernel's own folder-grant semantics. Never an editor.
 */
export function FilePane({ path }: { path: string }) {
  const { orgId } = useOrg();
  const [state, setState] = useState<{ content: string; truncated: boolean } | { error: string } | null>(null);
  const [flash, setFlash] = useState(false);
  const lastRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      desk.readFileForView(orgId, path).then((r) => {
        if (cancelled) return;
        if (r.ok) {
          if (lastRef.current !== null && lastRef.current !== r.content) {
            setFlash(true);
            window.setTimeout(() => setFlash(false), 600);
          }
          lastRef.current = r.content;
          setState({ content: r.content, truncated: r.truncated });
        } else {
          setState({ error: r.error });
        }
      }).catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [orgId, path]);
  const crumbs = path.split(/[\\/]/).filter(Boolean);
  return (
    <div className={styles.filePane}>
      <div className={styles.fileHead}>
        <span className={styles.fileCrumbs} title={path}>
          {crumbs.length > 3 ? `…\\${crumbs.slice(-3).join('\\')}` : crumbs.join('\\')}
        </span>
        <button
          type="button" className={styles.stripBtn} aria-label="Reveal in folder"
          title="Reveal in folder" onClick={() => void desk.openPath(orgId, path)}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      {state === null ? (
        <div className={styles.fileEmpty}>Loading…</div>
      ) : 'error' in state ? (
        <div className={styles.fileEmpty}>{state.error}</div>
      ) : (
        <pre className={flash ? `${styles.fileBody} ${styles.fileFlash}` : styles.fileBody}>
          {state.content}
          {state.truncated ? '\n… (truncated — open in your editor for the rest)' : ''}
        </pre>
      )}
    </div>
  );
}

/** A clean Chrome user agent (2026-07-20, the Google-login find): Google's sign-in policy
 * hard-blocks user agents carrying an Electron/webview token (disallowed_useragent). We ARE
 * this exact Chromium — dropping the app tokens is honest, and it is what every desktop app
 * with an embedded browser does. */
const CHROME_UA = navigator.userAgent
  .replace(/\stentis-desktop\/[^\s]+/i, '')
  .replace(/\sElectron\/[^\s]+/, '');

/** The webview's surface as this pane drives it — no electron typings needed renderer-side. */
interface WebviewEl extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
  getWebContentsId(): number;
}

interface PanelLeaseState {
  task: string;
  mode: 'agent' | 'user';
  handBackReason: string | null;
}

/** The user's browser tab: plain <webview> on its own persistent partition — no node, popups
 * blocked (no allowpopups). Tier 31: the webview registers its webContentsId with the main
 * driver so a LEASED agent can drive this exact visible surface; the indicator strip below
 * is the ONE owner of "who has the wheel" (LAW 1) and carries the user's revoke/resume. */
export function BrowserPane() {
  const viewRef = useRef<WebviewEl | null>(null);
  const [url, setUrl] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const [lease, setLease] = useState<PanelLeaseState | null>(null);

  // Guest registration (D-131): report the webview's id on dom-ready, clear it on unmount.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onReady = (): void => {
      try { void desk.panelBrowserGuest(el.getWebContentsId()); } catch { /* not ready */ }
    };
    el.addEventListener('dom-ready', onReady);
    return () => {
      el.removeEventListener('dom-ready', onReady);
      void desk.panelBrowserGuest(null);
    };
  }, [current === null]);

  // FR-340: the indicator poll — quiet, 1.5s, only while this pane exists.
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      desk.panelBrowserState().then((s) => { if (!cancelled) setLease(s); }).catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // A leased pane always has a REAL surface: if the agent holds the wheel before the user
  // ever typed a URL, mount the webview on about:blank so the guest registers (D-131).
  useEffect(() => {
    if (lease !== null && current === null) setCurrent('about:blank');
  }, [lease, current]);

  function go(): void {
    const raw = url.trim();
    if (!raw) return;
    // Omnibox behavior (user-directed 2026-07-20): explicit scheme → as-is; something
    // domain-shaped (a dot, no spaces) → https; anything else → a Google search, like
    // every real browser.
    let target: string;
    if (/^https?:\/\//i.test(raw)) target = raw;
    else if (!raw.includes(' ') && raw.includes('.')) target = `https://${raw}`;
    else target = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    setCurrent(target);
    setUrl(target);
  }

  return (
    <div className={styles.browser}>
      {lease !== null ? (
        <div className={lease.mode === 'user' ? `${styles.driveStrip} ${styles.driveStripUser}` : styles.driveStrip}>
          <span className={styles.driveText}>
            {lease.mode === 'user'
              ? `Your turn: ${lease.handBackReason ?? 'complete the step, then hand it back'}`
              : `Agent driving — ${lease.task}`}
          </span>
          {lease.mode === 'user' ? (
            <button type="button" className={styles.driveBtn} onClick={() => void desk.panelBrowserUserAction('resume')}>
              Give it back
            </button>
          ) : null}
          <button type="button" className={styles.driveBtnStop} onClick={() => void desk.panelBrowserUserAction('revoke')}>
            Take the wheel
          </button>
        </div>
      ) : null}
      <div className={styles.urlRow}>
        <button type="button" className={styles.stripBtn} aria-label="Back" onClick={() => viewRef.current?.goBack()}>
          <ArrowLeft size={14} />
        </button>
        <button type="button" className={styles.stripBtn} aria-label="Forward" onClick={() => viewRef.current?.goForward()}>
          <ArrowRight size={14} />
        </button>
        <button type="button" className={styles.stripBtn} aria-label="Reload" onClick={() => viewRef.current?.reload()}>
          <RotateCw size={13} />
        </button>
        <input
          className={styles.urlInput}
          placeholder="Enter a URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
        />
      </div>
      {current !== null ? (
        /* allowpopups (2026-07-20): OAuth flows open popup windows (accounts.google.com) that
           share this session and close themselves — a popup-less browser cannot log in. This
           is the USER's own browsing surface; popups here are normal browser behavior. */
        <webview
          ref={viewRef as never}
          src={current}
          className={styles.webview}
          partition="persist:userbrowse"
          useragent={CHROME_UA}
          allowpopups={'true' as never}
        />
      ) : (
        <div className={styles.browserEmpty}>Type a URL above to browse.</div>
      )}
    </div>
  );
}
