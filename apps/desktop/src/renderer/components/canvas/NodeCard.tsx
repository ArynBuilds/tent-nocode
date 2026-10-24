import { memo } from 'react';
import { citizenWord } from '@nodeloom/core';
import { FrameFace } from './FrameFace.js';
import type { ScreenFrameProps } from './FrameFace.js';
import { NodeFace, faceOf } from './NodeFace.js';
import styles from './canvas.module.css';

export interface CanvasNode {
  id: string;
  kind: string;
  label: string;
  /** Typed display word for the tile. */
  word?: string;
  detail: string | null;
  /** Half-wired quiet sentence. */
  quiet?: string | null;
  /** Living face: renders in icon zone instead of glyph. */
  face?: { kind: 'grid'; cols: number; rows: number } | { kind: 'value'; value: string };
  /** Service slug for integration-shaped nodes. */
  service?: string;
  /** Ghost sockets: required-but-unfed fields as drop targets. */
  sockets?: string[];
  /** Close-zoom grow rows and last-run word. */
  grow?: Array<{ k: string; v: string }>;
  growExtra?: string | null;
  /** Run badge callback for replaying last run. */
  onBadge?: () => void;
  /** Folded scene preview: first screen's mini-render. */
  previewSceneId?: string;
  /** Last run's badge. */
  badge?: import('./NodeFace.js').NodeBadge;
}

/** A card's data, functions left out: the memo compares what the card shows. */
const sameNode = (a: CanvasNode, b: CanvasNode): boolean => a === b
  || JSON.stringify(a, (_k, v: unknown) => (typeof v === 'function' ? undefined : v)) === JSON.stringify(b, (_k, v: unknown) => (typeof v === 'function' ? undefined : v));

interface NodeCardProps {
  node: CanvasNode;
  x: number;
  y: number;
  width: number;
  height: number;
  active?: boolean;
  /** Legal landing spot for wire in flight. */
  wireTarget?: boolean;
  /** Stable doors: the engine hands the same functions every render, so an untouched card never re-renders. */
  onDown: (e: React.PointerEvent<HTMLDivElement>, node: CanvasNode) => void;
  onMenu: (e: React.MouseEvent<HTMLDivElement>, node: CanvasNode) => void;
  /** Present: renders true-size live page instead of tile/fold. */
  frame?: ScreenFrameProps;
  /** Camera zoom regime. */
  zoom?: 'far' | 'rest' | 'close';
}

/** Node card: unified card grammar for all depths; delegates body to NodeFace by face id. */
export const NodeCard = memo(function NodeCard({ node, x, y, width, height, active, wireTarget, onDown, onMenu, frame, zoom = 'rest' }: NodeCardProps) {
  // Screen frame sheds card cage - hairline and label above.
  const natural = frame !== undefined;
  const cls = [
    styles.node,
    natural ? styles.nodeNatural : '',
    !natural && faceOf(node.kind) === 'live-frame' ? styles.nodeFold : '',
    // Zoom regimes dress the tile; frames and fold cards stand outside them.
    !natural && faceOf(node.kind) !== 'live-frame' && zoom === 'far' ? styles.nodeFar : '',
    !natural && faceOf(node.kind) !== 'live-frame' && zoom === 'close' ? styles.nodeClose : '',
    active === true ? styles.nodeActive : '',
    wireTarget === true ? styles.nodeWireTarget : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      style={{ left: x, top: y, width, height }}
      data-canvas-node={node.id}
      title={`${citizenWord(node.kind)} · ${node.label}${node.detail !== null ? ` · ${node.detail}` : ''}`}
      onPointerDown={(e) => onDown(e, node)}
      onContextMenu={(e) => onMenu(e, node)}
    >
      {frame !== undefined
        ? <FrameFace frame={frame} width={width} height={height} />
        : <NodeFace node={node} height={height} width={width} zoom={zoom} />}
    </div>
  );
}, (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.active === b.active
  && a.wireTarget === b.wireTarget && a.zoom === b.zoom && a.onDown === b.onDown && a.onMenu === b.onMenu
  && a.frame?.screen === b.frame?.screen && a.frame?.focused === b.frame?.focused && sameNode(a.node, b.node));
