import { useEffect, useState } from 'react';
import type { VerbDoor } from '@tent-nocode/core';
import { PROXIMITY_RADIUS, SCREEN_VIEW_SCALE, hasInPort, hasOutPort, nearestNode, nodeScreenRect, toScreen, toolbarFor } from '../../lib/canvas/store.js';
import type { Camera, Placed } from '../../lib/canvas/store.js';
import { SelectionChrome } from './SelectionChrome.js';
import type { WireEndsGeom } from './WireLayer.js';
import {
  ActionToolbar, connectButton, doorButton, foldButton, propsButton, removeButton, spliceButton, unfoldButton,
} from './ActionToolbar.js';
import type { ToolbarButton } from './ActionToolbar.js';
import type { CanvasNode } from './NodeCard.js';
import styles from './chrome.module.css';

/**
 * THE AFFORDANCE LAW (2026-07-31): THE CHROME OVERLAY — every piece of interaction
 * chrome (port dots · the port + · the one ACTION toolbar) renders HERE, in an unscaled
 * layer above the camera-transformed canvas: content zooms, controls never do, and the
 * card's overflow box can no longer clip a port. Hit areas ≫ visuals (24px circles for
 * 10px dots). Ports keep THE PROXIMITY REVEAL (mid-gray whisper stepping full-bright
 * near the cursor) — they are wiring affordances, not toolbars.
 * ㊻ (user-ruled 2026-08-05): SELECTION SUMMONS THE TOOLBAR — hover summons NOTHING.
 * The strip renders for the SELECTED thing alone: a single-selected node pins its
 * contract strip (⑦'s pin, now the ONLY path); a CLICKED wire pins its ×/+ at the
 * wire's mid; a clicked frame label pins the fold strip. Dismissal rides the existing
 * selection lanes (Esc at the engine's bubble phase · the still-click on empty
 * ground). The hover-summoned branch and its safe-triangle hold died here, grep-zero.
 */

export interface ChromeWire {
  index: number;
  /** Canvas units (the ONE wireEnds geometry WireLayer draws from). */
  ends: WireEndsGeom;
  onSplice?: () => void;
  onRemove?: () => void;
}

export function CanvasChrome({ scrollRef, cam, nodes, pos, wFor, hFor, wires, nodeFold, suppress, selectedIds, selectedWire = null, selectionSentence = null, naturalOf, onPortDown, outPortsFor, onPortPlus, onNodeVerb, onProps, nodeExtras }: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  cam: Camera;
  nodes: CanvasNode[];
  pos: ReadonlyMap<string, Placed>;
  /** ㊺: per-node width (natural frames beside ordinary cards). */
  wFor: (id: string) => number;
  hFor: (id: string) => number;
  wires: ChromeWire[];
  /** B3 (㉓): the fold door — 'unfold' (dissolve, the 2026-08-19 fold ruling)
   * replaces a folded group's toolbar whole; 'fold' joins a foldable selection. */
  nodeFold?: (n: CanvasNode) => { verb: 'fold' | 'unfold'; act: () => void } | null;
  /** A gesture in flight (pan · drag · marquee · wire) — the toolbar stands down. */
  suppress: boolean;
  /** ⑦: the mount's selection — every member gets the shape outline; a SINGLE
   * selection pins its toolbar. */
  selectedIds?: ReadonlySet<string>;
  /** ㊻: the CLICKED wire (index into `wires`) — its ×/+ strip pins at the mid. */
  selectedWire?: number | null;
  /** N10 (the node tile): the single selection's ONE plain sentence — rendered
   * under the selected card at constant screen size; null = nothing. */
  selectionSentence?: string | null;
  /** ⑦: screen frames render square — the card's own rendered truth (radius 0),
   * derived from the fresh frame lane (P1). */
  naturalOf?: (n: CanvasNode) => boolean;
  /** Present = wiring is live on this mount; ports render. */
  onPortDown?: (e: React.PointerEvent<HTMLSpanElement>, id: string, port?: string) => void;
  /** Named OUT ports where a step has >1 way out (If, Batches, Split, Compare). */
  outPortsFor?: (id: string) => string[] | null;
  onPortPlus?: (n: CanvasNode) => void;
  onNodeVerb?: (n: CanvasNode, door: VerbDoor) => void;
  /** The ⋯ door — the engine routes to the mount's properties opener. */
  onProps: (n: CanvasNode) => void;
  /** P3 (E11): mount-provided extra buttons leading the pinned strip — the
   * screen's Play door rides here (the standing full-screen surface). */
  nodeExtras?: (n: CanvasNode) => ToolbarButton[];
}) {
  const [cursor, setCursor] = useState<Placed | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    // Direct state per move (no rAF indirection): pointermove already ticks at input
    // rate, React batches, and the chrome must track even when rAF is throttled.
    const onMove = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onLeave = (): void => setCursor(null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [scrollRef]);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rects = nodes.flatMap((n) => {
    const p = pos.get(n.id);
    return p === undefined ? [] : [{ id: n.id, rect: nodeScreenRect(cam, p, wFor(n.id), hFor(n.id)) }];
  });
  const rectById = new Map(rects.map((r) => [r.id, r.rect]));

  // ㊻: proximity serves the PORT reveal alone now — no toolbar rides the cursor.
  const nearId = cursor !== null && !suppress ? nearestNode(cursor, rects, PROXIMITY_RADIUS) : null;

  // ---- The node strip (⑦: pinned on the single selection — the ONE toolbar path). ----
  function nodeToolbar(n: CanvasNode, r: { x: number; y: number; w: number; h: number }): React.ReactNode {
    // B3 (㉓): the fold door — a folded GROUP's toolbar is unfold, whole (its
    // members' contract verbs would lie); a foldable selection gains fold.
    const fold = nodeFold?.(n) ?? null;
    const buttons: ToolbarButton[] = [];
    if (fold !== null && fold.verb === 'unfold') {
      buttons.push(unfoldButton(fold.act));
    } else {
      buttons.push(...(nodeExtras?.(n) ?? [])); // P3: Play leads the screen strip
      for (const item of toolbarFor(n.kind)) {
        if (item.act === 'verb' && onNodeVerb !== undefined) buttons.push(doorButton(item.door, () => onNodeVerb(n, item.door)));
        else if (item.act === 'props') buttons.push(propsButton(() => onProps(n)));
        else if (item.act === 'connect' && onPortPlus !== undefined) buttons.push(connectButton(() => onPortPlus(n)));
      }
      if (fold !== null) buttons.push(foldButton(fold.act));
    }
    return <ActionToolbar x={r.x + r.w / 2} y={r.y - 8} buttons={buttons} />;
  }

  // ⑦ → ㊻: THE SELECTION PINS ITS TOOLBAR — the only summons. A multi-selection
  // pins NO strip (a Set has no primary anchor; fold stays on Ctrl+G and the
  // right-click menu — recorded call; the lens's multi strip is the AlignBar).
  let pinned: React.ReactNode = null;
  let sentence: React.ReactNode = null;
  const pinnedId = selectedIds !== undefined && selectedIds.size === 1 ? [...selectedIds][0]! : null;
  if (pinnedId !== null && !suppress) {
    const n = byId.get(pinnedId);
    const r = rectById.get(pinnedId);
    if (n !== undefined && r !== undefined) {
      pinned = nodeToolbar(n, r);
      // N10 THE SENTENCE ON SELECT: the F6 words come to the canvas — one quiet
      // line under the selected tile, constant screen size (the affordance law).
      if (selectionSentence !== null && selectionSentence !== '') {
        sentence = (
          <div className={styles.selSentence} style={{ left: r.x + r.w / 2, top: r.y + r.h + 8 }}>
            {selectionSentence}
          </div>
        );
      }
    }
  }

  // ㊻: the CLICKED wire pins its ×/+ strip at the wire's midpoint.
  let wireStrip: React.ReactNode = null;
  if (selectedWire !== null && !suppress) {
    const w = wires.find((c) => c.index === selectedWire);
    if (w !== undefined) {
      const buttons: ToolbarButton[] = [];
      if (w.onSplice !== undefined) buttons.push(spliceButton(w.onSplice));
      if (w.onRemove !== undefined) buttons.push(removeButton(w.onRemove));
      const mid = toScreen(cam, { x: w.ends.mid, y: (w.ends.y1 + w.ends.y2) / 2 });
      wireStrip = <ActionToolbar x={mid.x} y={mid.y - 10} buttons={buttons} />;
    }
  }

  return (
    // ⑦: --cz hands the camera zoom to the outline's radius (the card's own --r2
    // THROUGH the camera; the border weight stays constant screen px).
    <div className={styles.chrome} style={{ '--cz': cam.zoom } as React.CSSProperties}>
      {/* ⑦ SHAPE-FAITHFUL SELECTION: one thin accent outline per selected card,
          hugging the card's exact rendered shape (natural frames square). */}
      {selectedIds !== undefined && selectedIds.size > 0 ? rects.map(({ id, rect }) => {
        if (!selectedIds.has(id)) return null;
        const n = byId.get(id);
        const square = n !== undefined && naturalOf?.(n) === true;
        return (
          <span key={`sel-${id}`}>
            {/* The one chrome (P1); screens carry the page-unit size badge. */}
            <SelectionChrome
              rect={rect}
              k={1}
              {...(square ? {} : { radius: `calc(var(--r2) * var(--cz, 1))` })}
              badge={square ? `${Math.round(rect.w / cam.zoom / SCREEN_VIEW_SCALE)} × ${Math.round(rect.h / cam.zoom / SCREEN_VIEW_SCALE)}` : null}
            />
          </span>
        );
      }) : null}
      {onPortDown !== undefined ? rects.map(({ id, rect }) => {
        const n = byId.get(id);
        if (n === undefined) return null;
        const nearCls = nearId === id ? ` ${styles.portNear}` : '';
        const midY = rect.y + rect.h / 2;
        const outX = rect.x + rect.w;
        return (
          <span key={id}>
            {hasInPort(n.kind) ? (
              <span className={`${styles.portDot}${nearCls}`} style={{ left: rect.x, top: midY }} />
            ) : null}
            {hasOutPort(n.kind) ? (() => {
              // The spec's connection points: one labeled port per way out;
              // [] = NO way out (Stop draws none - "Stop has no output").
              const outs = outPortsFor?.(id) ?? null;
              if (outs !== null && outs.length === 0) return null;
              if (outs !== null && outs.length > 1) {
                return outs.map((port, i) => {
                  const y = rect.y + (rect.h * (i + 1)) / (outs.length + 1);
                  return (
                    <span key={port}>
                      <span className={`${styles.portDot}${nearCls}`} style={{ left: outX, top: y }} />
                      <span className={`${styles.portWord}${nearCls}`} style={{ left: outX + 9, top: y }}>{port.replace(/[-_]+/g, ' ')}</span>
                      <span
                        className={styles.portHit} style={{ left: outX, top: y }}
                        onPointerDown={(e) => onPortDown(e, id, port)}
                      />
                    </span>
                  );
                });
              }
              // B3 (spec ③): the resting ➕ chip DIED — creation chrome is intent-only.
              return (
                <>
                  <span className={`${styles.portDot}${nearCls}`} style={{ left: outX, top: midY }} />
                  <span
                    className={styles.portHit} style={{ left: outX, top: midY }}
                    onPointerDown={(e) => onPortDown(e, id)}
                  />
                </>
              );
            })() : null}
          </span>
        );
      }) : null}
      {pinned}
      {sentence}
      {wireStrip}
    </div>
  );
}
