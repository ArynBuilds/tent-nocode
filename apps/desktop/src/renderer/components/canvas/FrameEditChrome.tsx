import { PRIMITIVES, elementClassOf, primitiveOfNode } from '@nodeloom/core';
import { SCREEN_VIEW_SCALE, store, toScreen, useValue } from '../../lib/canvas/store.js';
import type { Camera, ElementRecord, Placed, Rect, ScreenRecord } from '../../lib/canvas/store.js';
import { alignElements } from '../../lib/page-edit/positionGround.js';
import { desk } from '../../lib/desk.js';
import { pinnedToolbarFor } from '../page-edit/elementDoors.js';
import type { ElementDoorCtx, GestureEdit } from '../page-edit/elementDoors.js';
import { useEditor } from './CanvasEngine.js';
import { ActionToolbar } from './ActionToolbar.js';
import { FrameOverlay } from '../page-edit/FrameOverlay.js';
import { AlignBar } from '../page-edit/AlignBar.js';
import styles from '../page-edit/editor.module.css';
import canvasStyles from './canvas.module.css';

// THE EDIT CHROME OVER A FOCUSED SCREEN (Phase 12, row 12.16): two mounts read the same records - the layer
// inside the camera (outlines, handles, spacing, the landing, the guides, the edge grips, at the screen's
// world origin through the miniature scale) and the unscaled overlay above it (the size badge, the align
// strip, the run chip, the element's wire-out port and its emit ports). Both feed the machine one target.

const PAD_ZONE = 6;

interface Placedrect { id: string; rect: Rect; r?: string }

/** The element rects of a screen in world units, from the face's live measure. */
function useWorldRects(screen: ScreenRecord): { origin: Placed | null; rectOf: (id: string) => (Rect & { r?: string }) | null } {
  const editor = useEditor();
  const origin = useValue(`chrome.origin.${screen.nodeId}`, () => store.positionOf(screen.nodeId) ?? null, [screen.nodeId]);
  const frame = useValue(`chrome.frame.${screen.nodeId}`, () => editor.frameOf(screen.nodeId), [screen.nodeId]);
  const rectOf = (id: string): (Rect & { r?: string }) | null => {
    const r = frame?.rects.get(id);
    if (r === undefined || origin === null) return null;
    const s = SCREEN_VIEW_SCALE;
    return { x: origin.x + r.x * s, y: origin.y + r.y * s, w: r.w * s, h: r.h * s, ...(r.r !== undefined ? { r: r.r } : {}) };
  };
  return { origin, rectOf };
}

const frameLayout = (el: ElementRecord | undefined): { layout: string } | null => {
  const prim = el !== undefined ? primitiveOfNode(el.node) : null;
  if (prim === null || prim.name !== 'frame') return null;
  return { layout: String(prim.payload['layout'] ?? 'none') };
};

export function FrameEditLayer({ screen }: { screen: ScreenRecord }) {
  const editor = useEditor();
  const slug = screen.slug;
  const { origin, rectOf } = useWorldRects(screen);
  const sel = useValue('chrome.sel', () => store.selectedElement(), []);
  const hover = useValue('chrome.hover', () => store.hover.element, []);
  const gesture = useValue('chrome.gesture', () => store.gesture, []);
  const textEditing = useValue('chrome.text', () => store.editing.text, []);
  const elements = useValue(`chrome.elements.${slug}`, () => store.elementsOf(slug), [slug]);
  if (origin === null) return null;
  const s = SCREEN_VIEW_SCALE;
  const toWorld = (r: Rect): Rect => ({ x: origin.x + r.x * s, y: origin.y + r.y * s, w: r.w * s, h: r.h * s });
  const mine = sel !== null && sel.scene === slug ? sel : null;
  const selectedEl = mine !== null ? store.element(slug, mine.elementId) : undefined;
  const selectedRect = mine !== null ? rectOf(mine.elementId) : null;
  const selected: Placedrect | null = mine !== null && selectedRect !== null ? { id: mine.elementId, rect: selectedRect, ...(selectedRect.r !== undefined ? { r: selectedRect.r } : {}) } : null;
  const extras = mine !== null ? mine.extras.flatMap((id) => { const r = rectOf(id); return r === null ? [] : [{ id, rect: r }]; }) : [];
  const hoverRect = hover !== null && hover.scene === slug && hover.id !== 'root' ? rectOf(hover.id) : null;
  const parentId = selectedEl?.node.parent ?? null;
  const parentRect = parentId !== null ? rectOf(parentId) : null;
  const parent = parentId !== null && parentRect !== null ? { id: parentId, rect: parentRect } : null;

  // Spacing zones: the gap after the selected child in a stack, and the padding edges of a selected frame.
  const spacing: Array<{ id: string; key: 'gap' | 'padding'; edge?: 'left' | 'right' | 'top' | 'bottom'; rect: Rect; axis: 'x' | 'y' }> = [];
  if (selected !== null && parentId !== null && parentRect !== null) {
    const pl = frameLayout(store.element(slug, parentId));
    if (pl !== null && (pl.layout === 'row' || pl.layout === 'column')) {
      const rail = store.childrenOf(slug, parentId);
      const next = rail[rail.indexOf(selected.id) + 1];
      const nr = next !== undefined ? rectOf(next) : null;
      const row = pl.layout === 'row';
      if (nr !== null) {
        const rect: Rect = row
          ? { x: selected.rect.x + selected.rect.w, y: selected.rect.y, w: Math.max(2 * s, nr.x - (selected.rect.x + selected.rect.w)), h: selected.rect.h }
          : { x: selected.rect.x, y: selected.rect.y + selected.rect.h, w: selected.rect.w, h: Math.max(2 * s, nr.y - (selected.rect.y + selected.rect.h)) };
        spacing.push({ id: parentId, key: 'gap', rect, axis: row ? 'x' : 'y' });
      }
    }
  }
  if (selected !== null && frameLayout(selectedEl) !== null && elements.some((e) => e.node.parent === selected.id)) {
    const r = selected.rect;
    const z = PAD_ZONE * s;
    spacing.push(
      { id: selected.id, key: 'padding', edge: 'left', rect: { x: r.x, y: r.y, w: z, h: r.h }, axis: 'x' },
      { id: selected.id, key: 'padding', edge: 'right', rect: { x: r.x + r.w - z, y: r.y, w: z, h: r.h }, axis: 'x' },
      { id: selected.id, key: 'padding', edge: 'top', rect: { x: r.x, y: r.y, w: r.w, h: z }, axis: 'y' },
      { id: selected.id, key: 'padding', edge: 'bottom', rect: { x: r.x, y: r.y + r.h - z, w: r.w, h: z }, axis: 'y' },
    );
  }

  const elementGesture = mine !== null;
  const landing = gesture.landing !== null && gesture.landing.scene === slug
    ? { line: toWorld(gesture.landing.line), parent: (() => { const pr = rectOf(gesture.landing.parent); return pr; })() }
    : null;
  const guides = elementGesture
    ? { x: gesture.guides.x !== null ? origin.x + gesture.guides.x * s : null, y: gesture.guides.y !== null ? origin.y + gesture.guides.y * s : null }
    : { x: null, y: null };
  const ghost = elementGesture && gesture.ghost !== null ? toWorld(gesture.ghost) : null;
  const size = store.sizeOf(screen.nodeId);

  return (
    <FrameOverlay
      at={{ scene: slug, screenId: screen.nodeId }}
      selected={selected !== null && selected.id !== 'root' ? selected : null}
      extras={extras} hover={hoverRect !== null && hover !== null ? { id: hover.id, rect: hoverRect, ...(hoverRect.r !== undefined ? { r: hoverRect.r } : {}) } : null}
      parent={parent} spacing={spacing} landing={landing} guides={guides} ghost={ghost}
      screenRect={{ x: origin.x, y: origin.y, w: size.w, h: size.h }}
      resizable={selected !== null && selected.id !== 'root'} rotatable={selected !== null && selected.id !== 'root' && extras.length === 0}
      textEditing={textEditing !== null && textEditing.scene === slug}
      onTarget={(target, e) => editor.inputs.pointerDown(e, target)}
    />
  );
}

/** The each binding enclosing an element - present lights the "Show a column" door. */
function repeatBindingOf(scene: string, id: string): string | null {
  let cur = store.element(scene, id)?.node.parent ?? null;
  let hops = 0;
  while (cur !== null && hops < 64) {
    const el = store.element(scene, cur);
    if (el === undefined) return null;
    const each = primitiveOfNode(el.node)?.payload['each'];
    if (typeof each === 'string') return each;
    if (each !== null && typeof each === 'object' && typeof (each as Record<string, unknown>)['query'] === 'string') return (each as Record<string, unknown>)['query'] as string;
    cur = el.node.parent;
    hops += 1;
  }
  return null;
}

/** The element doors' ctx over this screen: the ops ride the kernel wall directly (the live push refreshes the store). */
function doorCtx(orgId: string, slug: string, size: { w: number; h: number }, quiet: (s: string) => void): ElementDoorCtx {
  return {
    orgId, editSlug: slug, projectId: store.projectId, size,
    commitDirect: async (edit: GestureEdit): Promise<boolean> => {
      const r = await desk.sceneApplyOps(orgId, edit.sceneSlug ?? slug, edit.ops).catch(() => null);
      const ok = r !== null && r.ok && (r.data === undefined || r.data.ok);
      if (!ok) quiet(`${edit.label} did not land`);
      return ok;
    },
    quietSay: quiet,
    navTo: (to: string) => { const s = store.screenBySlugOf(to); if (s !== undefined) store.requestScreenFocus(s.sceneId); },
  };
}

export function FrameEditOverlay({ screen }: { screen: ScreenRecord }) {
  const editor = useEditor();
  const slug = screen.slug;
  const { rectOf } = useWorldRects(screen);
  const cam = useValue('overlay.cam', () => store.camera, []);
  const sel = useValue('overlay.sel', () => store.selectedElement(), []);
  const gesture = useValue('overlay.gesture', () => ({ badge: store.gesture.badge, busy: store.gesture.ghost !== null || store.gesture.wire !== null || store.gesture.brush !== null }), []);
  const pendingRun = useValue('overlay.run', () => store.editing.pendingRun, []);
  const mine = sel !== null && sel.scene === slug && sel.elementId !== 'root' ? sel : null;
  const el = mine !== null ? store.element(slug, mine.elementId) : undefined;
  const rect = mine !== null ? rectOf(mine.elementId) : null;
  const view = editor.view();
  const c: Camera = cam;
  if (mine === null || el === undefined || rect === null) return null;
  const px = (p: Placed): Placed => { const q = toScreen(c, p); return { x: q.x - 0, y: q.y - 0 }; };
  const topLeft = px({ x: rect.x, y: rect.y });
  const bottomRight = px({ x: rect.x + rect.w, y: rect.y + rect.h });
  const frameW = Math.round(rect.w / SCREEN_VIEW_SCALE);
  const frameH = Math.round(rect.h / SCREEN_VIEW_SCALE);
  const prim = primitiveOfNode(el.node);
  const cls = elementClassOf(el.node.components);
  const emits = prim !== null ? Object.entries(PRIMITIVES[prim.name].emits) : [];
  const members = [mine.elementId, ...mine.extras].flatMap((id) => { const e = store.element(slug, id); const r = rectOf(id); return e !== undefined && r !== null ? [{ el: e, rect: r }] : []; });
  const parentId = el.node.parent;
  const parentRect = parentId !== null ? rectOf(parentId) : null;
  const port = (kind: 'element-port' | 'emit-port', extra: Record<string, unknown>) => (e: React.PointerEvent): void => {
    e.preventDefault(); e.stopPropagation();
    if (kind === 'element-port') editor.inputs.pointerDown(e, { kind, scene: slug, screenId: screen.nodeId, id: mine.elementId, cls });
    else editor.inputs.pointerDown(e, { kind, scene: slug, screenId: screen.nodeId, id: mine.elementId, emit: String(extra['emit']), emitType: String(extra['emitType']) });
  };
  const orgId = store.orgId;
  const strip = !gesture.busy && mine.extras.length === 0 && orgId !== null
    ? pinnedToolbarFor(doorCtx(orgId, slug, screen.size, (s) => editor.doors.quiet(s)), el.node, cls, {
      mounted: { id: screen.sceneId, slug, title: screen.title },
      fire: (nodeId) => editor.frameOf(screen.nodeId)?.fire(nodeId),
      repeatBinding: repeatBindingOf(slug, mine.elementId),
    })
    : [];
  return (
    <div className={styles.frameEditOverlay} style={{ left: 0, top: 0, width: view?.width ?? 0, height: view?.height ?? 0 }}>
      {!gesture.busy || gesture.badge !== null ? (
        <span className={styles.badge} style={{ left: (topLeft.x + bottomRight.x) / 2, top: bottomRight.y }}>{gesture.badge ?? `${frameW} x ${frameH}`}</span>
      ) : null}
      {strip.length > 0 ? <ActionToolbar x={(topLeft.x + bottomRight.x) / 2} y={topLeft.y - 8} buttons={strip} /> : null}
      {!gesture.busy && mine.extras.length === 0 ? (
        <>
          <span className={canvasStyles.elPort} style={{ left: bottomRight.x, top: (topLeft.y + bottomRight.y) / 2 }} title={`wire this ${cls}`} onPointerDown={port('element-port', {})} />
          {emits.map(([emit, def], i) => (
            <span key={emit} className={canvasStyles.elPortSrc} style={{ left: bottomRight.x, top: bottomRight.y + 10 + i * 16 }} title={`${emit}: ${def.hint}`} onPointerDown={port('emit-port', { emit, emitType: def.type })}>
              <span className={canvasStyles.elPortScreenWord}>{emit}</span>
            </span>
          ))}
        </>
      ) : null}
      {pendingRun !== null && pendingRun.scene === slug && pendingRun.elementId === mine.elementId ? (
        <button type="button" className={styles.runChip} style={{ left: (topLeft.x + bottomRight.x) / 2, top: topLeft.y - 6 }} onClick={() => { editor.frameOf(screen.nodeId)?.fire(mine.elementId); store.setEditing({ pendingRun: null }); }}>
          run{pendingRun.name !== null ? ` ${pendingRun.name}` : ''}
        </button>
      ) : null}
      {mine.extras.length > 0 && parentRect !== null && !gesture.busy ? (
        <AlignBar
          members={members} parentRect={parentRect} at={{ x: topLeft.x, y: topLeft.y }} zoom={c.zoom}
          onCommit={(verb, label) => {
            const puts = alignElements(members.map((m) => ({ el: m.el, rect: { x: m.rect.x / SCREEN_VIEW_SCALE, y: m.rect.y / SCREEN_VIEW_SCALE, w: m.rect.w / SCREEN_VIEW_SCALE, h: m.rect.h / SCREEN_VIEW_SCALE } })), { x: parentRect.x / SCREEN_VIEW_SCALE, y: parentRect.y / SCREEN_VIEW_SCALE, w: parentRect.w / SCREEN_VIEW_SCALE, h: parentRect.h / SCREEN_VIEW_SCALE }, verb);
            void editor.history.transaction(label, () => store.put(puts, 'user'));
          }}
        />
      ) : null}
    </div>
  );
}
