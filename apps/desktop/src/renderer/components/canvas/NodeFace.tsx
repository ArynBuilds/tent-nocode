import { NODE_CONTRACTS } from '@nodeloom/core';
import type { FaceId } from '@nodeloom/core';
import { SceneScreen } from '../tabs/SceneScreen.js';
import { brandMarkFor } from './brandMarks.js';
import { kindHue, kindIcon } from '../../lib/canvas/store.js';
import { humanLabel } from '../../lib/page-edit/flowWires.js';
import { NODE_W } from '../../lib/canvas/store.js';
import styles from './canvas.module.css';

/** Generic face renderer: unified tile and folded app card formats. */

/** Run badge: corner indicator with tone vocabulary. */
export type NodeBadgeTone = 'error' | 'ok' | 'issue' | 'pinned' | 'dirty';
export interface NodeBadge { tone: NodeBadgeTone; text?: string }

export interface FaceNode {
  id: string;
  kind: string;
  label: string;
  /** Typed display word for name slot. */
  word?: string;
  detail: string | null;
  /** Half-wired quiet sentence. */
  quiet?: string | null;
  /** Living face: renders in icon zone instead of glyph. */
  face?: { kind: 'grid'; cols: number; rows: number } | { kind: 'value'; value: string };
  /** Service slug for mark shelf. */
  service?: string;
  /** Ghost sockets: required-but-unfed fields. */
  sockets?: string[];
  /** Close-zoom grow rows and last-run word. */
  grow?: Array<{ k: string; v: string }>;
  growExtra?: string | null;
  /** Run badge callback for replaying. */
  onBadge?: () => void;
  /** Folded app preview: first screen mini-render. */
  previewSceneId?: string;
  /** Last run's word. */
  badge?: NodeBadge;
}

/** The contract's face id for a kind (unknown kinds fall to the stat card, honestly). */
export function faceOf(kind: string): FaceId {
  return (NODE_CONTRACTS as Record<string, { face: FaceId }>)[kind]?.face ?? 'stat-card';
}

/** Design-size the folded mini render assumes; the real design size only changes the crop. */
const MINI_W = 1440;

export function NodeFace({ node, height, width = NODE_W, zoom = 'rest' }: {
  node: FaceNode; height: number; width?: number;
  /** Camera zoom regime. */
  zoom?: 'far' | 'rest' | 'close';
}) {
  const face = faceOf(node.kind);
  const hue = kindHue(node.kind);
  const Icon = kindIcon(node.kind);

  // Folded app card: previews first screen in mini card.
  if (face === 'live-frame' && node.previewSceneId !== undefined) {
    const innerW = width - 12;
    const frameH = height - 26;
    const k = innerW / MINI_W;
    return (
      <span className={styles.faceLive}>
        <span className={styles.faceLiveTitle}>
          <Icon size={11} style={{ color: hue }} />
          <span className={styles.nodeLabel}>{node.word ?? humanLabel(node.label)}</span>
        </span>
        <span className={styles.faceLiveFrame} style={{ width: innerW, height: frameH }}>
          <span className={styles.faceLiveScale} style={{ width: MINI_W, height: frameH / k, transform: `scale(${k})` }}>
            <SceneScreen sceneId={node.previewSceneId} />
          </span>
        </span>
      </span>
    );
  }

  // Tile: glyph in upper zone, words at bottom.
  const badgeTones: Partial<Record<NodeBadgeTone, string>> = {
    error: styles.runBadgeError ?? '', ok: styles.runBadgeOk ?? '',
    pinned: styles.runBadgePinned ?? '', dirty: styles.runBadgeDirty ?? '',
  };
  const badgeClass = node.badge !== undefined ? badgeTones[node.badge.tone] : undefined;
  const badge = badgeClass !== undefined ? node.badge : undefined;
  const sub = node.quiet ?? node.detail;
  // Living faces in icon zone; integrations show service mark; else glyph.
  const fd = node.face;
  const mark = brandMarkFor(node.service);
  return (
    <>
      {node.kind === 'trigger' ? <span className={styles.startCap} /> : null}
      <span className={styles.tileIcon}>
        {fd?.kind === 'grid' ? (
          <span className={styles.ghostGrid} aria-hidden>
            {Array.from({ length: Math.max(1, Math.min(3, fd.rows)) }, (_, r) => (
              <span key={r} className={styles.ghostRow}>
                {Array.from({ length: Math.max(1, Math.min(3, fd.cols)) }, (_, c) => (
                  <span key={c} className={styles.ghostCell} />
                ))}
              </span>
            ))}
          </span>
        ) : fd?.kind === 'value' ? (
          <span className={styles.tileValue}>{fd.value}</span>
        ) : mark !== null ? (
          mark
        ) : (
          <Icon size={26} />
        )}
      </span>
      {/* Ghost sockets: drop targets on left edge per field. */}
      {zoom !== 'far' ? node.sockets?.map((f, i) => (
        <span key={f} className={styles.tileSocket} style={{ top: 24 + i * 22 }} data-tile-socket={f}>
          {f} ←
        </span>
      )) : null}
      {zoom !== 'far' ? (
        <span className={styles.tileWords}>
          <span className={styles.tileName}>{node.word ?? humanLabel(node.label)}</span>
          {sub != null && sub !== '' ? <span className={styles.tileSub}>{sub}</span> : null}
        </span>
      ) : null}
      {/* Close regime grows face in place. */}
      {zoom === 'close' && ((node.grow?.length ?? 0) > 0 || node.growExtra != null) ? (
        <span className={styles.tileGrow}>
          {node.grow?.map((r) => (
            <span key={r.k} className={styles.growRow}>
              <span className={styles.growK}>{r.k}</span>
              <span className={styles.growV}>{r.v}</span>
            </span>
          ))}
          {node.growExtra != null ? (
            <span className={styles.growRow}>
              <span className={styles.growK}>last run</span>
              <span className={styles.growV}>{node.growExtra}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {badge !== undefined ? (
        node.onBadge !== undefined ? (
          /* Badge is clickable to replay run. */
          <button
            type="button" className={`${styles.runBadge} ${styles.runBadgeDoor} ${badgeClass ?? ''}`}
            aria-label="Replay the last run"
            onClick={(e) => { e.stopPropagation(); node.onBadge?.(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >{badge.text ?? ''}</button>
        ) : (
          <span className={`${styles.runBadge} ${badgeClass ?? ''}`}>
            {badge.text ?? ''}
          </span>
        )
      ) : null}
    </>
  );
}
