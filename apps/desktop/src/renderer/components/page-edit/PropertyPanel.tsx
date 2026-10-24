import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DEFAULT_BREAKPOINTS, PRIMITIVES, primitiveOfNode, primitiveRef } from '@nodeloom/core';
import type { PrimitiveName } from '@nodeloom/core';
import { store, useValue } from '../../lib/canvas/store.js';
import type { ElementRecord, InspectorSelection } from '../../lib/canvas/store.js';
import { desk } from '../../lib/desk.js';
import { useActiveEditor } from '../canvas/CanvasEngine.js';
import { PANEL_STATES, rootSectionsFor, scopedBlock, sectionsFor, sharedSectionsFor, visibleRows, withScopedValue } from './panelGroups.js';
import type { PanelParent, PanelScope, PanelState, RowSpec, SectionSpec } from './panelGroups.js';
import { PropertyRow, sentence } from './PropertyRow.js';
import styles from './editor.module.css';

// THE SCHEMA-DRIVEN PANEL (Phase 12, row 12.16): any primitive renders from primitives.ts - one section per
// shared group plus its own; the header's state switch and breakpoint switch scope every row (a hover fill
// lands in states.hover, a phone width in at.phone, and the face previews the same state); a multi-selection
// renders the shared groups alone and writes to every member. Every write is one store diff through the
// editor's history.

const CLOSED_BY_DEFAULT: ReadonlySet<string> = new Set(['motion', 'visibility', 'a11y']);

export function PropertyPanel({ selection }: { selection: InspectorSelection }) {
  const editor = useActiveEditor();
  const ids = [selection.nodeId, ...(selection.extraIds ?? [])];
  const scene = selection.sceneSlug;
  const elements = useValue('panel.elements', () => ids.map((id) => store.element(scene, id)).filter((e): e is ElementRecord => e !== undefined), [scene, ids.join('|')]);
  const editing = useValue('panel.editing', () => store.editing, []);
  const scope: PanelScope = { state: editing.previewState, breakpoint: editing.breakpoint };
  const [closed, setClosed] = useState<ReadonlySet<string>>(CLOSED_BY_DEFAULT);

  if (elements.length === 0) return <div className={styles.panelQuiet}>{editor === null ? 'open the workspace to edit this element' : 'that element is not on the canvas any more'}</div>;
  // The root may carry no frame component yet - it reads as a frame; a first write lands the component.
  const prims = elements.map((e) => ({
    el: e,
    prim: primitiveOfNode(e.node)
      ?? (e.node.id === 'root' ? { name: 'frame' as PrimitiveName, ref: primitiveRef('frame'), payload: {} as Record<string, unknown> } : null),
  }));
  const names = prims.flatMap((p) => (p.prim !== null ? [p.prim.name] : []));
  if (names.length === 0) return <div className={styles.panelQuiet}>this element is not one of the five - the panel has no rows for it</div>;
  const single = prims.length === 1 ? prims[0]! : null;
  // The screen's artboard (user-ruled): the Screen section then the root frame's ruled rows alone.
  const isRoot = single !== null && single.el.node.id === 'root';
  const sections: SectionSpec[] = single !== null && single.prim !== null ? (isRoot ? rootSectionsFor() : sectionsFor(single.prim.name)) : sharedSectionsFor(names);
  const firstPayload = prims[0]!.prim?.payload ?? {};
  const values = scopedBlock(firstPayload, scope);
  const defaults = scopedBlock(firstPayload, { state: 'default', breakpoint: null });
  const scoped = scope.state !== 'default' || scope.breakpoint !== null;
  // The parent frame's layout gates the free/pin/cell rows (a grid child shows its cell, a free child its pin).
  const parentId = prims[0]!.el.node.parent;
  const parentEl = parentId !== null ? store.element(scene, parentId) : undefined;
  const parentPrim = parentEl !== undefined ? primitiveOfNode(parentEl.node) : null;
  const parent: PanelParent | null = parentId === null ? null
    : { layout: (parentPrim !== null && parentPrim.name === 'frame' ? String(parentPrim.payload['layout'] ?? 'none') : 'none') as PanelParent['layout'] };

  function write(key: string, value: unknown, label: string): void {
    if (editor === null) return;
    const puts: ElementRecord[] = prims.flatMap(({ el, prim }) => {
      if (prim === null) return [];
      const payload = withScopedValue(prim.payload, scope, key, value);
      return [{ ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } }];
    });
    void editor.history.transaction(label, () => store.put(puts, 'user'));
  }

  const title = isRoot ? (selection.sceneTitle !== '' ? selection.sceneTitle : 'root') : single !== null ? single.el.node.id : `${prims.length} elements`;
  const kindWord = isRoot ? 'screen' : single !== null && single.prim !== null ? PRIMITIVES[single.prim.name].title : names.every((n) => n === names[0]) ? PRIMITIVES[names[0] as PrimitiveName].title : 'mixed';
  const breakpoints = Object.keys(DEFAULT_BREAKPOINTS);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelTitle}>
          <span className={styles.panelWord}>{title}</span>
          <span className={styles.panelKind}>{kindWord}{!isRoot && selection.sceneTitle !== '' ? ` on ${selection.sceneTitle}` : ''}</span>
        </div>
        <div className={styles.panelSwitches}>
          <span className={styles.segment}>
            {PANEL_STATES.map((s: PanelState) => (
              <button key={s} type="button" className={`${styles.segmentBtn} ${scope.state === s ? styles.segmentOn : ''} ${scope.state === s && s !== 'default' ? styles.segmentLive : ''}`} onClick={() => store.setEditing({ previewState: s })}>{sentence(s)}</button>
            ))}
          </span>
          <span className={styles.segment}>
            <button type="button" className={`${styles.segmentBtn} ${scope.breakpoint === null ? styles.segmentOn : ''}`} onClick={() => store.setEditing({ breakpoint: null })}>All</button>
            {breakpoints.map((bp) => (
              <button key={bp} type="button" className={`${styles.segmentBtn} ${scope.breakpoint === bp ? styles.segmentOn : ''} ${scope.breakpoint === bp ? styles.segmentLive : ''}`} onClick={() => store.setEditing({ breakpoint: bp })}>{sentence(bp)}</button>
            ))}
          </span>
        </div>
      </div>
      {isRoot ? <ScreenSection scene={scene} /> : null}
      {sections.map((section) => {
        const rows = visibleRows(section.rows, { ...defaults, ...values }, scope, parent);
        if (rows.length === 0) return null;
        const isClosed = closed.has(section.id);
        const setCount = rows.filter((r) => values[r.key] !== undefined).length;
        return (
          <div key={section.id} className={styles.section}>
            <button type="button" className={styles.sectionHead} onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(section.id)) n.delete(section.id); else n.add(section.id); return n; })}>
              {isClosed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              {sentence(section.title)}
              {setCount > 0 ? <span className={styles.sectionCount}>{setCount} set</span> : null}
            </button>
            {isClosed ? null : (
              <div className={styles.sectionBody}>
                {rows.map((r) => (
                  <PropertyRow
                    key={r.key} spec={r} value={values[r.key]} inherited={scoped ? defaults[r.key] : undefined} scoped={scoped}
                    onChange={(v) => write(r.key, v, `${r.label}${scoped ? ` (${scope.state !== 'default' ? scope.state : scope.breakpoint})` : ''}`)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!isRoot && single !== null && single.prim !== null && single.prim.name === 'frame' && editor !== null ? (
        <SaveAsComponent
          onSave={async (name) => {
            const org = store.orgId;
            if (org === null) return;
            const r = await desk.createComponentFromNode(org, scene, selection.nodeId, name, store.projectId ?? undefined);
            if (!r.ok) { editor.doors.quiet(r.error); return; }
            const d = r.data;
            if (d === undefined || !d.ok) { editor.doors.quiet(d !== undefined && !d.ok ? d.errors[0] ?? 'could not save the component' : 'could not save the component'); return; }
            editor.doors.quiet(`saved as ${d.ref} - place it as an instance`);
            void store.readCatalog();
          }}
        />
      ) : null}
    </div>
  );
}

// THE SCREEN SECTION (user-ruled): the artboard's own three rows - title, width, height. The title
// renames the view through the one rename door; width and height write the screen record as a 'user'
// put inside a history transaction so compileDiff carries them to humanSetTargetScreen (the edge grip's
// exact lane). The 200px floor is Resizing's.

const screenRow = (key: string, label: string, kind: RowSpec['kind'], hint: string): RowSpec =>
  ({ key, label, kind, unit: kind === 'number' ? 'px' : 'text', options: [], hint, fixed: false, atOk: false, type: '', range: null });

const SCREEN_ROWS = {
  title: screenRow('title', 'title', 'text', "the screen's name - the label above the artboard and the tab word"),
  width: screenRow('width', 'width', 'number', "the artboard's design width, px (min 200)"),
  height: screenRow('height', 'height', 'number', "the artboard's design height, px (min 200)"),
};

function ScreenSection({ scene }: { scene: string }) {
  const editor = useActiveEditor();
  const screen = useValue('panel.screen', () => store.screenBySlugOf(scene), [scene]);
  if (screen === undefined) return null;
  const putSize = (patch: Partial<{ w: number; h: number }>): void => {
    if (editor === null) return;
    const cur = store.screenBySlugOf(scene);
    if (cur === undefined) return;
    const size = { w: patch.w ?? cur.size.w, h: patch.h ?? cur.size.h };
    if (size.w === cur.size.w && size.h === cur.size.h) return;
    void editor.history.transaction('screen size', () => store.put([{ ...cur, size }], 'user'));
  };
  const asPx = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(200, Math.round(v)) : null);
  const rename = (v: unknown): void => {
    const next = String(v ?? '').trim();
    const org = store.orgId;
    if (next === '' || next === screen.title || org === null) return;
    void desk.humanRenameView(org, scene, next).then((res) => {
      if (!res.ok) { editor?.doors.quiet(res.error); return; }
      const cur = store.screenBySlugOf(scene);
      if (cur !== undefined) store.put([{ ...cur, title: next }], 'remote');
      void store.readTabs();
      void store.readGraph();
    });
  };
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead} style={{ cursor: 'default' }}>Screen</div>
      <div className={styles.sectionBody}>
        <PropertyRow spec={SCREEN_ROWS.title} value={screen.title} scoped={false} onChange={rename} />
        <PropertyRow spec={SCREEN_ROWS.width} value={screen.size.w} scoped={false} onChange={(v) => { const n = asPx(v); if (n !== null) putSize({ w: n }); }} />
        <PropertyRow spec={SCREEN_ROWS.height} value={screen.size.h} scoped={false} onChange={(v) => { const n = asPx(v); if (n !== null) putSize({ h: n }); }} />
      </div>
    </div>
  );
}

// SAVE AS COMPONENT (Phase 12R, row 12R.13): a selected frame's subtree becomes a saved library item
// through the standing mint; the inline name entry keeps the kebab name rules; the door reports quietly.

const kebabName = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 48);

function SaveAsComponent({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commit = (): void => {
    if (draft === null || busy) return;
    const name = kebabName(draft).replace(/^-+|-+$/g, '');
    if (name === '') { setDraft(null); return; }
    setBusy(true);
    void onSave(name).finally(() => { setBusy(false); setDraft(null); });
  };
  return (
    <div className={styles.section}>
      <div className={styles.sectionBody}>
        {draft === null
          ? <button type="button" className={styles.ghost} onClick={() => setDraft('')}>Save as component</button>
          : (
            <input
              className={styles.input} value={draft} placeholder="component-name" autoFocus disabled={busy}
              onChange={(e) => setDraft(kebabName(e.target.value))} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
            />
          )}
      </div>
    </div>
  );
}
