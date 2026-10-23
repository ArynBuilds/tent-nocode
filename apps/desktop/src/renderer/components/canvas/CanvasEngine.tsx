import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { atom, computed } from '@tldraw/state';
import { EDGE_VERB_WIRE_KINDS, elementPortRule, legalTargets } from '@tent-nocode/core';
import type { VerbDoor } from '@tent-nocode/core';
import {
  SCREEN_VIEW_SCALE, fitCameraTo, gridSpacing, isActiveAt, kindHue, sameWire, store, toWorld, trioCamera, useValue, verbSentence, wireAddressOf, zoomAt, zoomRegimeOf,
  type EdgeRecord, type NodeRecord, type Placed, type Rect,
} from '../../lib/canvas/store.js';
import { History } from '../../lib/canvas/history.js';
import { Inputs } from '../../lib/canvas/managers/inputs.js';
import { Snaps } from '../../lib/canvas/managers/snap.js';
import { Ticker } from '../../lib/canvas/managers/tick.js';
import { RootState, registerTools, type Doors, type Editor, type FrameGeometry, type PointerTarget } from '../../lib/canvas/tools/StateNode.js';
import { SelectTool } from '../../lib/canvas/tools/select/Idle.js';
import { CreateTool } from '../../lib/canvas/tools/create/Idle.js';
import { Hand } from '../../lib/canvas/tools/hand/Hand.js';
import { EditingText } from '../../lib/canvas/tools/select/EditingText.js';
import { engineWireGeometry } from './WireLayer.js';
import { navEdgesOf, withoutFlowLink } from '../../lib/page-edit/flowWires.js';
import { CanvasChrome } from './CanvasChrome.js';
import { NodeCard } from './NodeCard.js';
import type { CanvasNode } from './NodeCard.js';
import { LandedWires, WireLayer } from './WireLayer.js';
import { GuideChrome } from './SelectionChrome.js';
import { FrameEditLayer, FrameEditOverlay } from './FrameEditChrome.js';
import type { ToolbarButton } from './ActionToolbar.js';
import styles from './canvas.module.css';
import chromeStyles from './chrome.module.css';

// THE ONE CANVAS ENGINE (Phase 12, row 12.16): the React DOM over the store. It builds the editor once
// (the store, the history, the inputs, the snaps, the ticker, the tools), turns every pointer event into
// a target for the machine, and renders what the records say - the cards, the wires, the screens' faces,
// the gesture chrome inside the camera transform, the unscaled chrome above it.

registerTools(() => [SelectTool, CreateTool, Hand]);

const EditorContext = createContext<Editor | null>(null);
export function useEditor(): Editor {
  const e = useContext(EditorContext);
  if (e === null) throw new Error('useEditor outside the canvas engine');
  return e;
}
/** The mounted editor for surfaces outside the engine (the panels write through its history); null = no canvas. */
export const activeEditor = atom<Editor | null>('editor.active', null);
export function useActiveEditor(): Editor | null {
  return useValue('editor.active.read', () => activeEditor.get(), []);
}

export interface EngineEdge {
  from: string;
  to: string;
  hue: string;
  wireKind?: 'data' | 'watch' | 'permission' | 'flow';
  live?: boolean;
  toAnchor?: { left: number; right: number; y: number };
  title?: string;
  countWord?: string;
  onRemove?: () => void;
  onSplice?: () => void;
  address: ReturnType<typeof wireAddressOf>;
}

/** What the mount dresses the records with: badges, verbs, the fold door, the run replay, the edge doors. */
export interface EngineDecor {
  decorate: (node: NodeRecord) => CanvasNode;
  nodeFold: (node: CanvasNode) => { verb: 'fold' | 'unfold'; act: () => void } | null;
  nodeExtras: (node: CanvasNode) => ToolbarButton[];
  nodeProps: (node: CanvasNode) => (() => void) | undefined;
  outPortsFor: (id: string) => string[] | null;
  onNodeVerb: (node: CanvasNode, door: VerbDoor) => void;
  onPortPlus: (node: CanvasNode) => void;
  selectionSentence: string | null;
  activeIds: ReadonlySet<string>;
  edgeDoors: (e: EdgeRecord) => { onRemove?: () => void; onSplice?: () => void; countWord?: string };
  replay: { prev: string | null; node: string } | null;
}

export function CanvasEngine({ doors, decor, camResetKey, children }: {
  doors: Doors;
  decor: EngineDecor;
  camResetKey: string;
  children?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const doorsRef = useRef(doors);
  doorsRef.current = doors;
  const decorRef = useRef(decor);
  decorRef.current = decor;

  // The editor: one per mount; the doors read through the ref so the latest mount callbacks apply.
  const editor = useMemo<Editor>(() => {
    const frames = new Map<string, FrameGeometry>();
    const framesVersion = atom('frames.version', 0);
    const history = new History(store, { orgId: () => store.orgId, quiet: (s) => doorsRef.current.quiet(s) });
    const view = (): DOMRect | null => scrollRef.current?.getBoundingClientRect() ?? null;
    const toWorldFn = (client: Placed): Placed => {
      const v = view();
      const cam = store.peek<import('../../lib/canvas/store.js').CameraRecord>('camera')!;
      return toWorld(cam, { x: client.x - (v?.left ?? 0), y: client.y - (v?.top ?? 0) });
    };
    const ed = {
      store, history, snaps: new Snaps(), doors: new Proxy({} as Doors, { get: (_t, key) => (doorsRef.current as unknown as Record<string | symbol, unknown>)[key] }),
      view, toWorld: toWorldFn, frames, framesVersion,
      frameOf: (screenId: string) => { framesVersion.get(); return frames.get(screenId) ?? null; },
      elementWorldRect: (screenId: string, elementId: string): Rect | null => {
        framesVersion.get();
        const f = frames.get(screenId);
        const r = f?.rects.get(elementId);
        const origin = store.positionOf(screenId);
        if (f === undefined || r === undefined || origin === undefined) return null;
        return { x: origin.x + r.x * f.scale, y: origin.y + r.y * f.scale, w: r.w * f.scale, h: r.h * f.scale };
      },
    } as unknown as Editor;
    ed.inputs = new Inputs(() => ed);
    ed.ticker = new Ticker((elapsed) => { store.tick(elapsed); ed.root.handleEvent({ type: 'tick', elapsed }); });
    ed.root = new RootState(ed);
    ed.currentPath = computed('editor.path', () => ed.root.path.get());
    ed.root.enter({}, 'initial');
    return ed;
  }, []);

  // The mode record picks the tool; Space held is the hand.
  const mode = useValue('engine.mode', () => store.effectiveMode(), []);
  useEffect(() => { activeEditor.set(editor); return () => { if (activeEditor.get() === editor) activeEditor.set(null); }; }, [editor]);
  useEffect(() => { editor.root.setTool(mode); }, [editor, mode]);

  // The keyboard reaches the machine from the window (never from a typing surface); the root hears the chords.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (Inputs.inField(e)) return;
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); store.setMode({ spaceHeld: true }); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat) {
        const k = e.key.toLowerCase();
        if (k === 'v') { store.setMode({ picked: 'select' }); return; }
        if (k === 'h') { store.setMode({ picked: 'hand' }); return; }
        if (k === 'c') { store.setMode({ picked: 'create' }); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) void editor.history.redo(); else void editor.history.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); void editor.history.redo(); return; }
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit0')) {
        const v = editor.view();
        if (v === null || v.width < 80 || v.height < 80) return;
        const selection = [...store.selectedCardIds()].flatMap((id) => { const r = store.rectOf(id); return r === undefined ? [] : [r]; });
        const next = trioCamera(e.code, { cam: store.camera, view: { w: v.width, h: v.height }, bounds: store.bounds.get(), selection });
        if (next !== null) { e.preventDefault(); store.setCamera(next); }
        return;
      }
      editor.inputs.keyDown(e);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') store.setMode({ spaceHeld: false });
      if (Inputs.inField(e)) return;
      editor.inputs.keyUp(e);
    };
    const blur = (): void => { editor.inputs.interrupt(); store.setMode({ spaceHeld: false }); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    editor.ticker.start();
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      editor.ticker.stop();
    };
  }, [editor]);

  // The entry fit: ONE fit when content first appears, then the camera is the user's alone (user-ruled:
  // a screen resize must never zoom the map). A reset key re-arms exactly one more fit.
  const bounds = useValue('engine.bounds', () => store.bounds.get(), []);
  const cam = useValue('engine.camera', () => store.camera, []);
  useEffect(() => { store.setCamera({ x: 0, y: 0, zoom: 1 }, false); store.update('camera', (c) => ({ ...c, fitLive: true }), 'remote'); }, [camResetKey]);
  const hasNodes = useValue('engine.hasNodes', () => store.nodes.get().length > 0, []);
  useEffect(() => {
    if (!store.camera.fitLive || !hasNodes) return;
    const v = scrollRef.current?.getBoundingClientRect();
    if (v === undefined || v.width < 80 || v.height < 80) return;
    store.setCamera(fitCameraTo(bounds, { w: v.width, h: v.height }, 48), false);
    store.update('camera', (c) => ({ ...c, fitLive: false }), 'remote');
  }, [bounds.x, bounds.y, bounds.w, bounds.h, hasNodes]);

  // The screen focus request (the Layers pane, a verb door) re-frames the camera on the screen.
  const screenFocus = useValue('engine.screenFocus', () => store.panel.screenFocus, []);
  useEffect(() => {
    if (screenFocus === null) return;
    const id = `scene:${screenFocus.sceneId}`;
    const r = store.rectOf(id);
    const v = scrollRef.current?.getBoundingClientRect();
    if (r === undefined || v === undefined) return;
    store.selectCards([id]);
    store.setCamera(fitCameraTo(r, { w: v.width, h: v.height }, 80));
  }, [screenFocus]);

  const nodesRaw = useValue('engine.nodes', () => store.folded.get().nodes, []);
  const edgesRaw = useValue('engine.edges', () => store.folded.get().edges, []);
  const layout = useValue('engine.layout', () => store.layout.get(), []);
  const sel = useValue('engine.selection', () => store.selection.sel, []);
  const gesture = useValue('engine.gesture', () => store.gesture, []);
  const focused = useValue('engine.focused', () => store.focused.get(), []);
  const tapped = useValue('engine.tapped', () => store.editing.tapped, []);
  const screens = useValue('engine.screens', () => store.screens.get(), []);
  const selectedIds = sel?.kind === 'cards' ? new Set(sel.ids) : new Set<string>();
  const wireSel = sel?.kind === 'wire' ? sel.address : null;
  const nowMs = Date.now();

  const nodes: CanvasNode[] = nodesRaw.map((n) => decor.decorate(n));
  const byId = new Map(nodesRaw.map((n) => [n.id, n]));
  const sizeOf = (id: string): { w: number; h: number } => store.sizeOf(id);
  const wFor = (id: string): number => sizeOf(id).w;
  const hFor = (id: string): number => sizeOf(id).h;

  // Flow wires: the links the screens' documents carry, drawn between the screen cards.
  const flowEdges = useValue('engine.flowEdges', () => {
    const out: Array<{ from: string; to: string; title: string; scene: string; nodeId: string; targetSlug: string }> = [];
    for (const s of store.screens.get()) {
      const els = store.elementsOf(s.slug);
      if (els.length === 0) continue;
      for (const e of navEdgesOf(els.map((x) => x.node))) {
        const target = store.screenBySlug.get().get(e.targetSlug);
        if (target === undefined) continue;
        out.push({ from: s.nodeId, to: target.nodeId, title: `${s.title} leads to ${target.title}`, scene: s.slug, nodeId: e.nodeId, targetSlug: e.targetSlug });
      }
    }
    return out;
  }, []);

  const edges: EngineEdge[] = [
    ...edgesRaw.map((e): EngineEdge => {
      const d = decor.edgeDoors(e);
      const anchor = focused !== null && e.to === focused.nodeId && e.verb === 'shows' && e.from.startsWith('ds:') ? anchorFor(editor, focused.nodeId, focused.slug, e.from.slice('ds:'.length)) : null;
      const live = decor.activeIds.has(e.from) || decor.activeIds.has(e.to) || isActiveAt(byId.get(e.from)?.lastActivityAt ?? null, nowMs) || isActiveAt(byId.get(e.to)?.lastActivityAt ?? null, nowMs)
        || (decor.replay !== null && decor.replay.prev === e.from && decor.replay.node === e.to);
      return {
        from: e.from, to: e.to, hue: kindHue(byId.get(e.from)?.kind ?? ''), wireKind: EDGE_VERB_WIRE_KINDS[e.verb] ?? 'data', live,
        title: `${byId.get(e.from)?.label ?? ''} ${verbSentence(e.verb)} ${byId.get(e.to)?.label ?? ''}`,
        ...(d.onRemove !== undefined ? { onRemove: d.onRemove } : {}), ...(d.onSplice !== undefined ? { onSplice: d.onSplice } : {}),
        ...(d.countWord !== undefined ? { countWord: d.countWord } : {}), ...(anchor !== null ? { toAnchor: anchor } : {}),
        address: wireAddressOf(e),
      };
    }),
    ...flowEdges.map((f): EngineEdge => ({
      from: f.from, to: f.to, hue: kindHue('scene'), wireKind: 'flow', live: false, title: f.title, address: { from: f.from, to: f.to },
      onRemove: () => {
        const el = store.element(f.scene, f.nodeId);
        const next = el !== undefined ? withoutFlowLink(el.node, f.targetSlug) : null;
        if (el === undefined || next === null) return;
        void editor.history.transaction('unlink', () => store.put([{ ...el, node: next }], 'user'));
      },
    })),
  ];
  const { landed, chromeWires } = engineWireGeometry(edges, layout, hFor, wFor);

  // The selection plus everything one wire away stays lit; the rest dims.
  const lit = selectedIds.size > 0 ? (() => { const s = new Set(selectedIds); for (const e of edges) { if (selectedIds.has(e.from)) s.add(e.to); if (selectedIds.has(e.to)) s.add(e.from); } return s; })() : null;
  // A wire in flight lights its legal targets, read from the contract.
  const wireTargets = gesture.wire !== null ? (() => {
    if (gesture.wire.element !== undefined) { const cls = gesture.wire.element.cls; return new Set(nodesRaw.filter((n) => n.id !== gesture.wire!.fromId && elementPortRule(cls, n.kind) !== null).map((n) => n.id)); }
    return new Set(nodesRaw.filter((n) => n.id !== gesture.wire!.fromId && (legalTargets(byId.get(gesture.wire!.fromId)?.kind ?? '') as readonly string[]).includes(n.kind)).map((n) => n.id));
  })() : null;

  const targetOf = (e: React.PointerEvent, n: CanvasNode): PointerTarget => {
    const screen = store.screenOf(n.id);
    if (screen === undefined) return { kind: 'node', id: n.id };
    const onName = (e.target as HTMLElement).closest?.('[data-frame-name]') !== null;
    if (onName || e.ctrlKey || e.metaKey || (selectedIds.has(n.id) && focused?.nodeId !== n.id) || (selectedIds.has(n.id) && sel?.kind === 'cards')) return { kind: 'node', id: n.id, ...(onName ? { name: true } : {}) };
    const frame = editor.frameOf(n.id);
    const hit = frame?.hitTest({ x: e.clientX, y: e.clientY }) ?? null;
    return { kind: 'element', scene: screen.slug, screenId: n.id, id: hit };
  };

  function onCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest?.('[data-canvas-layer]') !== e.currentTarget.firstElementChild) {
      if ((e.target as HTMLElement).closest?.('[data-canvas-node]') !== null) return;
    }
    e.preventDefault();
    editor.inputs.pointerDown(e, { kind: 'canvas' });
  }

  function onNodePointerDown(e: React.PointerEvent<HTMLDivElement>, n: CanvasNode): void {
    const t = targetOf(e, n);
    const el = e.target as HTMLElement;
    const typing = el.closest?.('input, textarea, select, [contenteditable="true"]') !== null && t.kind === 'element' && focused?.nodeId === n.id && !e.ctrlKey;
    if (!typing) e.preventDefault();
    e.stopPropagation();
    if (typing) { const frame = editor.frameOf(n.id); const hit = frame?.hitTest({ x: e.clientX, y: e.clientY }) ?? null; if (hit !== null && t.kind === 'element') store.selectElement(t.scene, n.id, hit, []); store.setEditing({ tapped: n.id }); return; }
    editor.inputs.pointerDown(e, t);
  }

  function onCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (editor.inputs.isPointing) return;
    const el = (e.target as HTMLElement).closest?.('[data-canvas-node]');
    const id = el?.getAttribute('data-canvas-node') ?? null;
    let target: PointerTarget = { kind: 'canvas' };
    if (id !== null) {
      const screen = store.screenOf(id);
      if (screen !== undefined && (focused?.nodeId === id || tapped === id)) {
        const frame = editor.frameOf(id);
        target = { kind: 'element', scene: screen.slug, screenId: id, id: frame?.hitTest({ x: e.clientX, y: e.clientY }) ?? null };
      } else target = { kind: 'node', id };
    }
    editor.inputs.pointerMove(e, target);
  }

  function onZoomWheel(e: React.WheelEvent<HTMLDivElement>): void {
    e.preventDefault();
    const sc = scrollRef.current;
    if (!sc) return;
    const rect = sc.getBoundingClientRect();
    store.setCamera(zoomAt(store.camera, e.deltaY, e.clientX - rect.left, e.clientY - rect.top));
  }

  function onCanvasContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    if (gesture.wire !== null || gesture.brush !== null || gesture.grabbing) return;
    e.stopPropagation();
    const el = (e.target as HTMLElement).closest?.('[data-canvas-node]');
    const id = el?.getAttribute('data-canvas-node') ?? null;
    if (id !== null) {
      const screen = store.screenOf(id);
      if (screen !== undefined && focused?.nodeId === id) {
        const frame = editor.frameOf(id);
        editor.inputs.rightClick(e, { kind: 'element', scene: screen.slug, screenId: id, id: frame?.hitTest({ x: e.clientX, y: e.clientY }) ?? null });
        return;
      }
      editor.inputs.rightClick(e, { kind: 'node', id });
      return;
    }
    editor.inputs.rightClick(e, { kind: 'canvas' });
  }

  const gs = gridSpacing(cam.zoom);
  const cursor = gesture.cursor ?? (mode === 'create' ? 'crosshair' : mode === 'hand' ? 'grab' : undefined);
  const suppress = gesture.wire !== null || gesture.brush !== null || gesture.grabbing || gesture.createGhost !== null || mode !== 'select';
  const chromeSelectedWire = wireSel === null ? null : (() => { const i = edges.findIndex((e) => sameWire(e.address, wireSel)); return i >= 0 ? i : null; })();
  const openProps = (n: CanvasNode): void => { const door = decor.nodeProps(n); if (door !== undefined) door(); else { const full = byId.get(n.id); if (full !== undefined) doors.nodeOpen(full); } };

  return (
    <EditorContext.Provider value={editor}>
      <div
        className={gesture.grabbing ? `${styles.scroll} ${chromeStyles.scrollGrabbing}` : styles.scroll}
        style={{ backgroundSize: `${gs}px ${gs}px`, backgroundPosition: `${cam.x}px ${cam.y}px`, '--dotr': `${Math.min(2.4, Math.max(1.1, 1.3 * Math.sqrt(cam.zoom)))}px`, cursor } as React.CSSProperties}
        ref={scrollRef} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onWheel={onZoomWheel} onContextMenu={onCanvasContextMenu}
        onPointerLeave={() => store.setHover({ cursor: null, node: null, element: null })}
      >
        <div
          className={styles.canvas} data-canvas-layer
          style={{ width: bounds.w, height: bounds.h, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, transformOrigin: '0 0', '--cz': cam.zoom } as React.CSSProperties}
        >
          <LandedWires wires={landed} pos={layout} hFor={hFor} wFor={wFor} bounds={bounds} onSelect={(i) => { const e = edges[i]; if (e !== undefined) store.selectWire(e.address); }} />
          {nodes.map((n) => {
            const p = layout.get(n.id);
            if (!p) return null;
            const s = sizeOf(n.id);
            const screen = screens.find((x) => x.nodeId === n.id);
            return (
              <NodeCard
                key={n.id} node={n} zoom={zoomRegimeOf(cam.zoom)}
                active={decor.activeIds.has(n.id) || isActiveAt(byId.get(n.id)?.lastActivityAt ?? null, nowMs) || decor.replay?.node === n.id}
                dimmed={lit !== null && !lit.has(n.id)}
                wireTarget={wireTargets !== null && wireTargets.has(n.id)}
                height={s.h} width={s.w}
                style={{ left: p.x, top: p.y, width: s.w, height: s.h }}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const screenHit = store.screenOf(n.id) !== undefined && focused?.nodeId === n.id; if (screenHit) { const frame = editor.frameOf(n.id); editor.inputs.rightClick(e, { kind: 'element', scene: screen!.slug, screenId: n.id, id: frame?.hitTest({ x: e.clientX, y: e.clientY }) ?? null }); } else editor.inputs.rightClick(e, { kind: 'node', id: n.id }); }}
                frame={screen !== undefined ? { screen, focused: focused?.nodeId === n.id || tapped === n.id } : undefined}
              />
            );
          })}
          {sel?.kind === 'cards' ? <GuideChrome x={gesture.guides.x} y={gesture.guides.y} /> : null}
          {gesture.brush !== null ? <div className={styles.marquee} style={{ left: gesture.brush.x, top: gesture.brush.y, width: gesture.brush.w, height: gesture.brush.h }} /> : null}
          {gesture.createGhost !== null ? <div className={styles.createGhost} style={{ left: gesture.createGhost.x, top: gesture.createGhost.y, width: gesture.createGhost.w, height: gesture.createGhost.h }} /> : null}
          {gesture.wire !== null ? <WireLayer from={gesture.wire.from} to={gesture.wire.to} /> : null}
          {focused !== null ? <FrameEditLayer screen={focused} /> : null}
          {children}
        </div>
        <CanvasChrome
          scrollRef={scrollRef} cam={cam} nodes={nodes} pos={layout} wFor={wFor} hFor={hFor} wires={chromeWires}
          nodeFold={decor.nodeFold} selectedIds={selectedIds} selectionSentence={decor.selectionSentence}
          selectedWire={chromeSelectedWire}
          naturalOf={(n) => store.screenOf(n.id) !== undefined}
          suppress={suppress}
          onPortDown={mode === 'select' ? (e, id, port) => { e.preventDefault(); e.stopPropagation(); editor.inputs.pointerDown(e, { kind: 'port', id, ...(port !== undefined ? { port } : {}) }); } : undefined}
          outPortsFor={decor.outPortsFor} onPortPlus={decor.onPortPlus} onNodeVerb={decor.onNodeVerb} onProps={openProps} nodeExtras={decor.nodeExtras}
        />
        {focused !== null ? <FrameEditOverlay screen={focused} /> : null}
      </div>
    </EditorContext.Provider>
  );
}

/** A data wire into the focused screen fans to the frame or chart that reads the table. */
function anchorFor(editor: Editor, screenId: string, scene: string, dataset: string): { left: number; right: number; y: number } | null {
  const els = store.elementsOf(scene);
  const reader = els.find((e) => JSON.stringify(e.node.components).includes(`"${dataset}"`) && e.node.id !== 'root');
  const r = reader !== undefined ? editor.frameOf(screenId)?.rects.get(reader.node.id) : undefined;
  if (r === undefined || r.w === 0 || r.h === 0) return null;
  const s = SCREEN_VIEW_SCALE;
  return { left: r.x * s, right: (r.x + r.w) * s, y: (r.y + r.h / 2) * s };
}

export { EditingText };
