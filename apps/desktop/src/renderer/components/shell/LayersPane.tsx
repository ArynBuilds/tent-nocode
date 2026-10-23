import { useState } from 'react';
import { BarChart3, Box, ChevronDown, ChevronRight, Square, TextCursorInput, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { keyBetween, primitiveOfNode } from '@tent-nocode/core';
import type { PrimitiveName } from '@tent-nocode/core';
import { store, useValue } from '../../lib/canvas/store.js';
import type { ElementRecord, ScreenRecord } from '../../lib/canvas/store.js';
import { useActiveEditor } from '../canvas/CanvasEngine.js';
import styles from './sidepanel.module.css';
import { EmptyMark } from '../brand/EmptyMark.js';

// THE LAYERS TREE (Phase 12, row 12.16): the focused screen's elements as the store holds them, one row per
// element in rail order; a click selects on the canvas, a drag reorders or reparents (one diff), the
// chevrons fold branches. No reads of its own - the screens and elements are the records.

const ICONS: Record<PrimitiveName, LucideIcon> = { frame: Square, text: Type, field: TextCursorInput, chart: BarChart3, instance: Box };

interface Row { el: ElementRecord; depth: number; hasKids: boolean; name: PrimitiveName | null }

function wordOf(el: ElementRecord): string {
  const prim = primitiveOfNode(el.node);
  if (prim === null) return el.node.id;
  const p = prim.payload;
  if (prim.name === 'text' && typeof p['text'] === 'string') return p['text'].slice(0, 32);
  if (prim.name === 'field' && typeof p['label'] === 'string') return p['label'];
  if (prim.name === 'instance' && typeof p['component'] === 'string') return p['component'];
  return el.node.id;
}

function rowsOf(slug: string, closed: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const id of store.childrenOf(slug, parent)) {
      const el = store.element(slug, id);
      if (el === undefined) continue;
      const kids = store.childrenOf(slug, id);
      out.push({ el, depth, hasKids: kids.length > 0, name: primitiveOfNode(el.node)?.name ?? null });
      if (!closed.has(id)) walk(id, depth + 1);
    }
  };
  walk('root', 0);
  return out;
}

type Drop = { id: string; where: 'before' | 'after' | 'into' } | null;

export function LayersPane() {
  const editor = useActiveEditor();
  const screen = useValue('layers.screen', () => store.focused.get(), []);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [drop, setDrop] = useState<Drop>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const slug = screen?.slug ?? null;
  const version = useValue('layers.version', () => (slug !== null ? store.elementsOf(slug).length + store.elementsOf(slug).map((e) => e.node.parent + e.node.order).join('') : ''), [slug]);
  const sel = useValue('layers.sel', () => store.selectedElement(), []);
  if (screen === null || slug === null) return <EmptyMark line="Select a screen to see its layers." />;
  void version;
  const rows = rowsOf(slug, closed);
  const selectedIds = new Set(sel !== null && sel.scene === slug ? [sel.elementId, ...sel.extras] : []);

  function pick(el: ElementRecord, e: React.MouseEvent): void {
    const extras = e.shiftKey && sel !== null && sel.scene === slug ? [sel.elementId, ...sel.extras].filter((x) => x !== el.node.id) : [];
    store.selectElement(slug!, screen!.nodeId, el.node.id, extras);
    store.setEditing({ tapped: screen!.nodeId });
    store.retargetInspector({ sceneId: screen!.sceneId, sceneSlug: slug!, sceneTitle: screen!.title, nodeId: el.node.id, ...(extras.length > 0 ? { extraIds: extras } : {}) });
  }

  function land(target: Drop): void {
    const id = dragging;
    setDragging(null); setDrop(null);
    if (id === null || target === null || target.id === id || editor === null) return;
    const el = store.element(slug!, id);
    const at = store.element(slug!, target.id);
    if (el === undefined || at === undefined) return;
    let parent: string; let order: string;
    if (target.where === 'into') {
      parent = target.id;
      const rail = store.childrenOf(slug!, parent).filter((x) => x !== id);
      const last = rail.length > 0 ? store.element(slug!, rail[rail.length - 1]!)?.node.order ?? null : null;
      order = keyBetween(last, null);
    } else {
      parent = at.node.parent ?? 'root';
      const rail = store.childrenOf(slug!, parent).filter((x) => x !== id);
      const i = rail.indexOf(target.id);
      const beforeId = target.where === 'before' ? rail[i - 1] : rail[i];
      const afterId = target.where === 'before' ? rail[i] : rail[i + 1];
      order = keyBetween(beforeId !== undefined ? store.element(slug!, beforeId)?.node.order ?? null : null, afterId !== undefined ? store.element(slug!, afterId)?.node.order ?? null : null);
    }
    if (parent === id) return;
    void editor.history.transaction('move layer', () => store.put([{ ...el, node: { ...el.node, parent, order } }], 'user'));
  }

  const whereOf = (e: React.DragEvent, hasKids: boolean): 'before' | 'after' | 'into' => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (hasKids && y > 0.3 && y < 0.7) return 'into';
    return y < 0.5 ? 'before' : 'after';
  };

  return (
    <div className={styles.layers}>
      <div className={`${styles.layersHead} ${styles.layersHeadLive}`}>{screen.title}</div>
      {rows.length === 0 ? <EmptyMark compact line="This screen is empty. Draw something on it." /> : null}
      {rows.map((r) => {
        const Icon = r.name !== null ? ICONS[r.name] : Box;
        const id = r.el.node.id;
        const cls = [
          styles.layersRow,
          selectedIds.has(id) ? styles.layersRowSelected : '',
          dragging === id ? styles.layersRowDragging : '',
          drop?.id === id ? (drop.where === 'before' ? styles.layersRowBefore : drop.where === 'after' ? styles.layersRowAfter : styles.layersRowInto) : '',
        ].filter(Boolean).join(' ');
        return (
          <div
            key={id} className={cls} style={{ paddingLeft: 8 + r.depth * 14 }} draggable
            onClick={(e) => pick(r.el, e)}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragging(id); }}
            onDragOver={(e) => { e.preventDefault(); const where = whereOf(e, r.hasKids || r.name === 'frame'); if (drop?.id !== id || drop.where !== where) setDrop({ id, where }); }}
            onDragLeave={() => { if (drop?.id === id) setDrop(null); }}
            onDrop={(e) => { e.preventDefault(); land({ id, where: whereOf(e, r.hasKids || r.name === 'frame') }); }}
            onDragEnd={() => { setDragging(null); setDrop(null); }}
          >
            {r.hasKids ? (
              <button type="button" className={styles.layersChev} aria-label={closed.has(id) ? 'Open' : 'Close'} onClick={(e) => { e.stopPropagation(); setClosed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }}>
                {closed.has(id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
            ) : <span className={styles.layersChevGap} />}
            <Icon size={13} className={styles.layersIcon} />
            <span className={styles.layersWord}>{wordOf(r.el)}</span>
          </div>
        );
      })}
    </div>
  );
}
