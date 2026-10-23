import { useEffect, useRef, useState } from 'react';
import { NODE_CONTRACTS } from '@tent-nocode/core';
import type { NodeContract, VerbDoor } from '@tent-nocode/core';
import type { CitizenSelection } from '../../lib/canvas/store.js';
import { kindIcon } from '../../lib/canvas/store.js';
import { humanLabel } from '../../lib/page-edit/flowWires.js';
import { StepConfig, useStepWord } from './StepConfig.js';
import { TriggerConfig } from './TriggerConfig.js';
import type { TriggerMinted } from './TriggerConfig.js';
import { IntegrationProperties } from '../shell/IntegrationProperties.js';
import { NodeDetails } from './NodeDetails.js';
import styles from './configcard.module.css';

/** Config card shell: unified card for all map node types — steps, triggers, tables, verbs. */

const CARD_W = 288;

export type ConfigCardState =
  | { mode: 'node'; sel: CitizenSelection; client: { x: number; y: number } | null }
  | { mode: 'trigger-new'; prefill?: { dataset?: string; operation?: string }; client: { x: number; y: number } | null };

const stepAddress = (nodeId: string): { flowId: string; stepId: string } => {
  const [, flowId = '', stepId = ''] = nodeId.split(':');
  return { flowId, stepId };
};

export function NodeConfigCard({ orgId, projectId, card, datasets, operations, say, onVerb, onClose, onTriggerMinted, onTriggerReminted }: {
  orgId: string;
  projectId: string | null;
  card: ConfigCardState;
  /** The project's Tables / Tools - the pickers' rows (one list, every tenant). */
  datasets: string[];
  operations: string[];
  say: (sentence: string) => void;
  onVerb: (door: VerbDoor) => void;
  onClose: () => void;
  onTriggerMinted: (minted: TriggerMinted) => void;
  onTriggerReminted: (minted: TriggerMinted, oldTriggerId: string) => void;
}) {
  const sel = card.mode === 'node' ? card.sel : null;
  const kind = sel?.kind ?? 'trigger';
  const nodeId = sel?.nodeId ?? '';
  const addr = stepAddress(nodeId);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // The card rides its node: beside the right edge, flipped left when the viewport
  // ends, tracked every frame so pan/zoom never detaches it. The click point is
  // only the fallback when there is no node to ride (trigger-new).
  useEffect(() => {
    if (nodeId === '') {
      if (card.client !== null) {
        setPos({ left: Math.min(card.client.x, window.innerWidth - CARD_W - 16), top: Math.min(card.client.y, window.innerHeight - 280) });
      } else {
        setPos({ left: Math.max(8, window.innerWidth / 2 - CARD_W / 2), top: 140 });
      }
      return;
    }
    let raf = 0;
    let last: { left: number; top: number } | null = null;
    const measure = (): void => {
      const el = document.querySelector(`[data-canvas-node="${nodeId}"]`);
      if (el !== null) {
        const r = el.getBoundingClientRect();
        const rightFits = r.right + 14 + CARD_W <= window.innerWidth - 8;
        const left = Math.max(8, rightFits ? r.right + 14 : r.left - CARD_W - 14);
        const top = Math.max(8, Math.min(r.top, window.innerHeight - 340));
        if (last === null || Math.abs(last.left - left) > 0.5 || Math.abs(last.top - top) > 0.5) {
          last = { left, top };
          setPos(last);
        }
      }
      raf = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [nodeId, card.client]);

  // Esc first (the picker's capture idiom) + click-away.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const away = (e: MouseEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', away);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('mousedown', away); };
  }, [onClose]);

  const stepWord = useStepWord(orgId, addr.flowId, addr.stepId, sel?.label ?? '');
  if (pos === null) return null;
  const Icon = kindIcon(kind);
  const name = card.mode === 'trigger-new' ? 'New trigger'
    : nodeId.startsWith('fstep:') ? (humanLabel(stepWord) || 'Step')
      : nodeId.startsWith('trg:') ? 'Trigger'
        : humanLabel(sel?.label ?? '') || 'Node';

  return (
    <div ref={boxRef} className={styles.card} style={{ left: pos.left, top: pos.top }}>
      <div className={styles.head}>
        <span className={styles.headIcon}><Icon size={15} /></span>
        <span className={styles.name}>{name}</span>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>×</button>
      </div>
      {card.mode === 'trigger-new' ? (
        <TriggerConfig
          orgId={orgId} projectId={projectId} mode={{ dress: 'create', ...(card.prefill !== undefined ? { prefill: card.prefill } : {}) }}
          datasets={datasets} operations={operations} say={say}
          onMinted={onTriggerMinted} onReminted={onTriggerReminted}
        />
      ) : nodeId.startsWith('fstep:') ? (
        <StepConfig
          orgId={orgId} projectId={projectId} flowId={addr.flowId} stepId={addr.stepId}
          tables={datasets} say={say} onVerb={(d) => onVerb(d)} onGone={onClose}
        />
      ) : nodeId.startsWith('trg:') ? (
        <TriggerConfig
          orgId={orgId} projectId={projectId} mode={{ dress: 'edit', triggerId: nodeId.slice('trg:'.length) }}
          datasets={datasets} operations={operations} say={say}
          onMinted={onTriggerMinted} onReminted={onTriggerReminted}
        />
      ) : (
        <>
          {nodeId.startsWith('intg:') && sel !== null ? (
            <div className={styles.body}><IntegrationProperties selection={sel} /></div>
          ) : sel !== null ? (
            <div className={styles.details}><NodeDetails selection={sel} say={say} /></div>
          ) : null}
          <VerbFoot kind={kind} onVerb={onVerb} />
        </>
      )}
    </div>
  );
}

/** The generic foot - the kind's contract verbs, the one door registry. */
function VerbFoot({ kind, onVerb }: { kind: string; onVerb: (door: VerbDoor) => void }) {
  const verbs = (NODE_CONTRACTS as Record<string, NodeContract>)[kind]?.verbs ?? [];
  if (verbs.length === 0) return null;
  return (
    <div className={styles.foot}>
      {verbs.map((v) => (
        <button key={v.door} type="button" className={styles.verb} onClick={() => onVerb(v.door)}>{v.label}</button>
      ))}
    </div>
  );
}
