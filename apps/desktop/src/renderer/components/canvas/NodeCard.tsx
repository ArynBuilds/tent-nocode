import { citizenWord } from '@tent-nocode/core';
import { FrameFace } from './FrameFace.js';
import type { ScreenFrameProps } from './FrameFace.js';
import { NodeFace, faceOf } from './NodeFace.js';
import styles from './canvas.module.css';

/** Node card: unified card grammar for all depths; delegates body to NodeFace by face id. */

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

export function NodeCard({ node, active, dimmed, wireTarget, height, width, onPointerDown, onClick, onDoubleClick, onContextMenu, frame, title, style, zoom = 'rest' }: {
  node: CanvasNode;
  active?: boolean;
  /** Dimmed when outside selection neighborhood. */
  dimmed?: boolean;
  /** Legal landing spot for wire in flight. */
  wireTarget?: boolean;
  height: number;
  /** Card width; wide frames on screens canvas. */
  width?: number;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Right-click menu callback. */
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Present: renders true-size live page instead of tile/fold. */
  frame?: ScreenFrameProps;
  title?: string;
  style: React.CSSProperties;
  /** Camera zoom regime. */
  zoom?: 'far' | 'rest' | 'close';
}) {
  // Screen frame sheds card cage — hairline and label above.
  const natural = frame !== undefined;
  const cls = [
    styles.node,
    natural ? styles.nodeNatural : '',
    !natural && faceOf(node.kind) === 'live-frame' ? styles.nodeFold : '',
    // Zoom regimes dress the tile; frames and fold cards stand outside them.
    !natural && faceOf(node.kind) !== 'live-frame' && zoom === 'far' ? styles.nodeFar : '',
    !natural && faceOf(node.kind) !== 'live-frame' && zoom === 'close' ? styles.nodeClose : '',
    active === true ? styles.nodeActive : '',
    dimmed === true ? styles.nodeDim : '',
    wireTarget === true ? styles.nodeWireTarget : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      style={style}
      data-canvas-node={node.id}
      title={title ?? `${citizenWord(node.kind)} · ${node.label}${node.detail !== null ? ` · ${node.detail}` : ''}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {frame !== undefined
        ? <FrameFace frame={frame} width={width ?? 0} height={height} />
        : <NodeFace node={node} height={height} width={width} zoom={zoom} />}
    </div>
  );
}
