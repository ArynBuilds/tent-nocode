import { useEffect, useState } from 'react';
import { desk } from '../../lib/desk.js';
import { toolLabel } from '../../lib/feed/labels.js';
import { useOrg } from '../../lib/OrgContext.js';
import styles from './shell.module.css';

// Ambient agent frames: one per out-of-sight running agent, bottom-right. Header owns in-thread liveness; frames prevent duplicate narration.
interface LiveAgent {
  runId: string;
  threadId: string | null;
  threadTitle: string;
  role: string;
  step: { kind: string; tool?: string; target?: string; text?: string } | null;
}

function stepLine(step: LiveAgent['step']): string {
  if (step === null) return 'Working';
  if (step.kind === 'thinking') return step.text !== undefined && step.text.length > 0 ? `Thought — ${step.text}` : 'Thinking';
  if (step.kind === 'text') return 'Writing';
  if (step.kind === 'tool') return toolLabel(step.tool ?? '', step.target) ?? 'Working';
  return 'Working';
}

// Stack shows ≤MAX_FRAMES; user can hide for session (×, session-scoped). Hiding is user choice, not narration.
const MAX_FRAMES = 3;

export function AgentFrames({ visibleThreadIds }: { visibleThreadIds: string[] }) {
  const { orgId } = useOrg();
  const [agents, setAgents] = useState<LiveAgent[]>([]);
  const [hiddenByUser, setHiddenByUser] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      desk.liveAgents(orgId).then((a) => { if (!cancelled) setAgents(a); }).catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [orgId]);

  const hidden = agents.filter((a) => a.threadId === null || !visibleThreadIds.includes(a.threadId));
  if (hidden.length === 0 || hiddenByUser) return null;

  const shown = hidden.slice(0, MAX_FRAMES);
  const more = hidden.length - shown.length;

  return (
    <div className={styles.agentFrames}>
      <button
        type="button"
        className={styles.agentFramesHide}
        title="Hide these frames until the app restarts"
        onClick={() => setHiddenByUser(true)}
      >×</button>
      {shown.map((a) => (
        <div key={a.runId} className={styles.agentFrame} title={a.threadTitle}>
          <span className={styles.agentFrameRole}>{a.role === 'desk' ? 'Tent NoCode' : a.role}</span>
          <span className={styles.agentFrameLine}>{stepLine(a.step)}</span>
        </div>
      ))}
      {more > 0 && <div className={styles.agentFrameMore}>+{more} more working</div>}
    </div>
  );
}
