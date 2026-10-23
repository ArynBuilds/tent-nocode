import { useEffect, useRef, useState } from 'react';
import { Crosshair, FileText, Globe, Layers, Network, PackageSearch, Plus, SquareCode, X } from 'lucide-react';
import type { PanelTab } from './panelPanes.js';
import styles from './sidepanel.module.css';

/**
 * Tier 52 Phase 3: THE ONE TAB STRIP — extracted verbatim from SidePanel.tsx so the bottom
 * panel carries the same tabs (reorder, marquee, labels, add menu) without duplicating a
 * line. All original rulings travel with the code: pointer-based reorder ("no icons on my
 * mouse"), active-tab scroll-into-view, the wheel-scrolling strip.
 */

/** Drag-reorder (user-directed 2026-07-20): move the dragged tab to the hovered tab's slot. */
function reorderTabs(list: PanelTab[], fromId: string, toId: string): PanelTab[] {
  const from = list.findIndex((t) => t.id === fromId);
  const to = list.findIndex((t) => t.id === toId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

interface PanelStripProps {
  tabs: PanelTab[];
  activeId: string;
  onTabs: (tabs: PanelTab[], activeId: string) => void;
  onClose: (id: string) => void;
  /** R0: the offerable kinds — Browser is NOT one (ruling 8b: entries hidden). */
  onAdd: (kind: 'workspace' | 'code' | 'nodeBrowser' | 'layers') => void;
}

/** R0: one icon + one label per kind — the strip renders every registered kind (a tab
 * can exist that no menu offers: the lease-opened browser keeps its face). */
const KIND_ICON = {
  file: FileText, inspector: Crosshair, workspace: Network,
  code: SquareCode, nodeBrowser: PackageSearch, browser: Globe, layers: Layers,
} as const;

// P3 (the editor-in-the-map arc, ruled): the displayed word is WORKSPACE - the
// internal kind stays plumbing. B4 (spec ㉖): the inspector's display word is
// PROPERTIES — same law, words only.
const KIND_LABEL = {
  file: '', inspector: 'Properties', workspace: 'Workspace',
  code: 'Code', nodeBrowser: 'Node browser', browser: 'Browser', layers: 'Layers',
} as const;

export function PanelStrip({ tabs, activeId, onTabs, onClose, onAdd }: PanelStripProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const stripScrollRef = useRef<HTMLDivElement | null>(null);

  // POINTER-based reorder (user-directed 2026-07-20, "no icons on my mouse"): native HTML5
  // drag always paints OS cursor adornments (move/no-drop/ghost) — so the reorder is raw
  // pointer events instead, exactly like the resize divider. Pointer capture keeps the drag
  // alive over the webview; the cursor stays the plain arrow the whole way.
  const tabsLiveRef = useRef(tabs);
  tabsLiveRef.current = tabs;
  const movedRef = useRef(false);

  function onTabPointerDown(e: React.PointerEvent<HTMLDivElement>, id: string): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button') !== null) return; // the close X is a click, never a drag
    movedRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
    const onMove = (ev: PointerEvent): void => {
      if (!movedRef.current) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        movedRef.current = true;
        setDragTabId(id);
      }
      const over = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-tabid]') ?? null) as HTMLElement | null;
      const overId = over?.getAttribute('data-tabid');
      if (typeof overId === 'string' && overId !== id) {
        onTabs(reorderTabs(tabsLiveRef.current, id, overId), activeId);
      }
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragTabId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // Overflow (user-directed 2026-07-20): the newly-active tab always scrolls into view —
  // a tab can never live outside the app's reach.
  useEffect(() => {
    stripScrollRef.current
      ?.querySelector(`[data-tabid="${activeId}"]`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeId, tabs.length]);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  /** Tab-label marquee (same physics as the thread rows): constant 30px/s, measured per
   * label on hover; a fitting label measures zero overflow and never moves. */
  function armMarquee(e: React.MouseEvent<HTMLDivElement>): void {
    const inner = e.currentTarget.querySelector<HTMLElement>(`.${styles.tabLabelInner}`);
    const wrap = inner?.parentElement;
    if (!inner || !wrap) return;
    const overflow = Math.max(0, inner.scrollWidth - wrap.clientWidth);
    inner.style.setProperty('--marquee-ms', `${Math.round((overflow / 30) * 1000)}ms`);
  }

  return (
    <div className={styles.strip}>
      {/* The tabs region SCROLLS (wheel included); the + stays pinned outside it. */}
      <div
        className={styles.tabsScroll}
        ref={stripScrollRef}
        onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            data-tabid={t.id}
            className={[
              styles.tab,
              t.id === active?.id ? styles.tabActive : '',
              t.id === dragTabId ? styles.tabDragging : '',
            ].filter(Boolean).join(' ')}
            onClick={() => {
              if (movedRef.current) { movedRef.current = false; return; } // a drag is not a click
              onTabs(tabs, t.id);
            }}
            onMouseEnter={armMarquee}
            onPointerDown={(e) => onTabPointerDown(e, t.id)}
          >
            {(() => { const Icon = KIND_ICON[t.kind]; return <Icon size={13} />; })()}
            <span className={styles.tabLabel}>
              <span className={styles.tabLabelInner}>
                {t.kind === 'file' ? (t.path ?? '').replace(/^.*[\\/]/, '') : KIND_LABEL[t.kind]}
              </span>
            </span>
            <button
              type="button"
              className={styles.tabClose}
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className={styles.addWrap}>
        <button type="button" className={styles.stripBtn} aria-label="New panel tab" onClick={() => setMenuOpen((v) => !v)}>
          <Plus size={14} />
        </button>
        {menuOpen ? (
          <div className={styles.addMenu}>
            <button type="button" className={styles.addItem} onClick={() => { onAdd('workspace'); setMenuOpen(false); }}>
              <Network size={13} /> Workspace
            </button>
            <button type="button" className={styles.addItem} onClick={() => { onAdd('code'); setMenuOpen(false); }}>
              <SquareCode size={13} /> Code
            </button>
            <button type="button" className={styles.addItem} onClick={() => { onAdd('nodeBrowser'); setMenuOpen(false); }}>
              <PackageSearch size={13} /> Node browser
            </button>
            {/* ㊿ (user-ruled 2026-08-05): the layers tree joins the offerable kinds. */}
            <button type="button" className={styles.addItem} onClick={() => { onAdd('layers'); setMenuOpen(false); }}>
              <Layers size={13} /> Layers
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
