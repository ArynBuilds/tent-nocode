import { useEffect, useRef } from 'react';
import { DEFAULT_BREAKPOINTS } from '@tent-nocode/core';
import { mountScene } from '@tent-nocode/tentkit';
import type { EditorEvent, SceneData, SceneMount } from '@tent-nocode/tentkit';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { useLivePush } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { SCREEN_VIEW_SCALE, canvasView, store, useValue } from '../../lib/canvas/store.js';
import type { Placed, Rect, ScreenRecord } from '../../lib/canvas/store.js';
import type { FrameGeometry } from '../../lib/canvas/tools/StateNode.js';
import { EditingText, useEditor } from './CanvasEngine.js';
import styles from './canvas.module.css';

// THE FRAME FACE (Phase 12, row 12.16): a screen on the canvas mounts tentkit's engine DIRECTLY in edit
// mode - no iframe, no port, no measure shim. The document is the store's (every element record), the data
// the one feed plus the live pushes, the theme the host CSS rescoped to this face. The face registers its
// geometry with the editor (measure, hit test, inline text, the run door) so every tool reads real pixels.

export interface ScreenFrameProps { screen: ScreenRecord; focused: boolean }

const feedOf = (results: ReadonlyArray<{ binding: string; rows: Record<string, unknown>[]; text: string | null; error: string | null }>): SceneData => {
  const data: SceneData = { rows: {}, texts: {}, errors: {} };
  for (const r of results) {
    data.rows![r.binding] = r.rows;
    data.texts![r.binding] = r.text;
    if (r.error !== null) data.errors![r.binding] = r.error;
  }
  return data;
};

// A screen mounts its live engine when it comes near the view at a readable size, and keeps it while it stays
// near; far off or too small, it rests as its frame and name. Px are screen px.
const ENTER_MIN_W = 80;
const KEEP_MIN_W = 56;

export function FrameFace({ frame, width, height }: { frame: ScreenFrameProps; width: number; height: number }) {
  const { screen, focused } = frame;
  const reach = useValue(`face.reach.${screen.nodeId}`, (): 'in' | 'keep' | 'out' => {
    const v = canvasView.get();
    const p = store.positionOf(screen.nodeId);
    if (p === undefined || v.w === 0) return 'in';
    const cam = store.camera;
    const w = width * cam.zoom; const h = height * cam.zoom;
    const x = cam.x + p.x * cam.zoom; const y = cam.y + p.y * cam.zoom;
    const within = (m: number): boolean => x + w > -m * v.w && y + h > -m * v.h && x < v.w * (1 + m) && y < v.h * (1 + m);
    if (w >= ENTER_MIN_W && within(0.5)) return 'in';
    if (w >= KEEP_MIN_W && within(1.5)) return 'keep';
    return 'out';
  }, [screen.nodeId, width, height]);
  const liveRef = useRef(false);
  liveRef.current = focused || reach === 'in' ? true : reach === 'out' ? false : liveRef.current;
  if (!liveRef.current) {
    return (
      <span className={styles.frameNatural} data-face={screen.id}>
        <span className={styles.frameName} data-frame-name>{screen.title}</span>
        <span className={`${styles.frameBody} ${styles.frameBodyRest} ${styles.frameResting}`} style={{ width, height }} />
      </span>
    );
  }
  return <LiveFrame frame={frame} width={width} height={height} />;
}

function LiveFrame({ frame, width, height }: { frame: ScreenFrameProps; width: number; height: number }) {
  const { screen, focused } = frame;
  const { orgId } = useOrg();
  const editor = useEditor();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<SceneMount | null>(null);
  const geomRef = useRef<FrameGeometry | null>(null);
  const slug = screen.slug;
  const doc = useValue(`face.doc.${slug}`, () => store.documentOf(slug), [slug]);
  const library = useValue('face.library', () => store.libraryItems.get(), []);
  const preview = useValue('face.preview', () => ({ state: store.editing.previewState, bp: store.editing.breakpoint, sel: store.selectedElement() }), []);
  const data = useQuery(`face.data:${screen.sceneId}`, () => desk.sceneData(orgId, screen.sceneId), [orgId, screen.sceneId]);
  const docRef = useRef(doc);
  docRef.current = doc;

  useLivePush((m) => {
    const mount = mountRef.current;
    if (mount === null) return;
    if (m.kind === 'binding' && m.sceneId === screen.sceneId) {
      if (m.error !== null) mount.setError(m.binding, m.error); else mount.setRows(m.binding, m.rows, m.text, m.tick);
    }
    if (m.kind === 'effects' && m.scene === slug) mount.applyEffects(m.effects);
  });

  // The mount: once per face; the document, the data and the library update in place.
  useEffect(() => {
    const host = hostRef.current;
    const first = docRef.current;
    if (host === null || first === null) return;
    const scale = (): number => { const r = host.getBoundingClientRect(); return r.width > 0 ? r.width / screen.size.w : SCREEN_VIEW_SCALE; };
    const toFrame = (client: Placed): Placed => { const r = host.getBoundingClientRect(); const s = scale(); return { x: (client.x - r.x) / s, y: (client.y - r.y) / s }; };
    const rects = new Map<string, Rect & { r?: string }>();
    const mount = mountScene(host, {
      document: first, mode: 'edit', hostEvents: true, library,
      theme: { breakpoints: { ...DEFAULT_BREAKPOINTS } },
      // The design width feeds the reflow; the breakpoint survives the device-switch remount (:115's size dep).
      designWidth: screen.size.w,
      breakpoint: store.editing.breakpoint,
      onAction: (name, values) => {
        void desk.sceneAction(orgId, slug, name, values).then((res) => {
          if (res.ok && res.data) { mount.actionResult(name, res.data.ok, res.data.ok ? [] : res.data.failures); mount.applyEffects(res.data.ok ? res.data.effects : []); }
          else mount.actionResult(name, false, [res.ok ? 'the action returned nothing' : res.error]);
        });
      },
      onNav: () => undefined,
    });
    mountRef.current = mount;
    const geom: FrameGeometry = {
      screenId: screen.nodeId, scene: slug, scale: SCREEN_VIEW_SCALE, rects,
      hitTest: (client) => mount.hitTest(client.x, client.y),
      editText: (id) => mount.editText(id),
      editCommand: (cmd, link) => mount.editCommand(cmd, link),
      fire: (id) => mount.fire(id),
      toFrame,
    };
    geomRef.current = geom;
    editor.frames.set(screen.nodeId, geom);
    editor.framesVersion.set(editor.framesVersion.get() + 1);
    const offRects = mount.on('rects', (m: EditorEvent['rects']) => {
      const r = host.getBoundingClientRect();
      const s = scale();
      rects.clear();
      let bottom = 0;
      for (const n of m.rects) {
        const fr: Rect & { r?: string } = { x: (n.x - r.x) / s, y: (n.y - r.y) / s, w: n.w / s, h: n.h / s, ...(n.r !== undefined ? { r: n.r } : {}) };
        rects.set(n.node, fr);
        // Content height counts the CONTENT alone: the root stretches to this host (min-height:100%),
        // so counting it would feed the card height back into itself and grow forever.
        if (n.node !== 'root' && fr.y + fr.h > bottom) bottom = fr.y + fr.h;
      }
      editor.framesVersion.set(editor.framesVersion.get() + 1);
      const contentH = Math.ceil(bottom);
      const cur = store.get<ScreenRecord>(screen.id);
      if (cur !== undefined && cur.contentH !== contentH && contentH > 0) store.update<ScreenRecord>(screen.id, (x) => ({ ...x, contentH }), 'remote');
    });
    const offText = mount.on('text', (e: EditorEvent['text']) => {
      const editing = editor.root.children?.['select']?.children?.['editingText'];
      if (editing instanceof EditingText) editing.endEdit({ ...(e.text !== undefined ? { text: e.text } : {}), ...(e.blocks !== undefined ? { blocks: e.blocks } : {}), ...(e.cancel === true ? { cancel: true } : {}) });
    });
    return () => {
      offRects(); offText();
      mount.unmount();
      mountRef.current = null;
      geomRef.current = null;
      editor.frames.delete(screen.nodeId);
      editor.framesVersion.set(editor.framesVersion.get() + 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, screen.nodeId, screen.id, slug, screen.size.w, doc === null]);

  useEffect(() => { if (doc !== null) mountRef.current?.update({ document: doc }); }, [doc]);
  useEffect(() => { mountRef.current?.update({ library }); }, [library]);
  useEffect(() => { if (data.data !== undefined) mountRef.current?.update({ data: feedOf(data.data.results) }); }, [data.data]);

  // The project theme's breakpoints replace the defaults once the feed names them (coupling 4).
  const themeBreakpoints = data.data?.breakpoints;
  useEffect(() => {
    if (themeBreakpoints !== undefined && Object.keys(themeBreakpoints).length > 0) mountRef.current?.update({ theme: { breakpoints: themeBreakpoints } });
  }, [themeBreakpoints]);

  // The panel's breakpoint switch previews through the engine's forced mode - no remount.
  useEffect(() => { mountRef.current?.setBreakpoint(preview.bp); }, [preview.bp]);

  // The panel's state switch previews on the selected element through the engine's own state attribute.
  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    const el = preview.sel !== null && preview.sel.scene === slug ? mount.elementOf(preview.sel.elementId) : null;
    if (el === null || preview.state === 'default') return;
    el.setAttribute('data-tk-state', preview.state);
    return () => el.removeAttribute('data-tk-state');
  }, [preview, slug]);

  const hostCss = data.data?.hostCss;
  const scoped = hostCss !== undefined && hostCss !== '' ? hostCss.replace(/:root\b/g, `[data-face="${screen.id}"]`) : null;
  const k = width / screen.size.w;
  return (
    <span className={styles.frameNatural} data-face={screen.id}>
      {scoped !== null ? <style>{scoped}</style> : null}
      <span className={`${styles.frameName} ${focused ? styles.frameNameLive : ''}`} data-frame-name>{screen.title}</span>
      <span className={`${styles.frameBody} ${focused ? styles.frameBodyLive : styles.frameBodyRest}`} style={{ width, height }}>
        <span className={styles.frameScale} style={{ width: screen.size.w, height: height / k, transform: `scale(${k})` }}>
          {/* Definite height (card height in frame units): the edit root's min-height:100% resolves against it. */}
          <div ref={hostRef} className={styles.frameScaleInner} style={{ width: screen.size.w, height: height / k }} />
        </span>
      </span>
    </span>
  );
}
