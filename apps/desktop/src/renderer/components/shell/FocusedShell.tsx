import { useEffect, useState } from 'react';
import { ArrowLeft, Minus, Square, X } from 'lucide-react';
import { SceneScreen } from '../tabs/SceneScreen.js';
import { Console } from './Console.js';
import type { ConsoleMode } from '../../lib/consoleState.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import styles from './shell.module.css';

// Focused app window: the scene renderer plus the room Console only when the project has an Assistant.
export function FocusedShell({ slug, onExit }: {
  slug: string;
  onExit: (() => void) | null;
}) {
  const { orgId } = useOrg();
  const { data: res, error, refetch } = useQuery(`focus:${orgId}:${slug}`, () => desk.ensureSceneThread(orgId, slug), [orgId, slug]);
  useLive(['runs', 'threads'], () => refetch());
  const room = res !== undefined && res.ok ? res.data : undefined;
  const failure = error ?? (res !== undefined && !res.ok ? res.error : undefined);
  const [mode, setMode] = useState<ConsoleMode>('pill');
  const [sticky, setSticky] = useState(false);

  useEffect(() => {
    if (room) document.title = room.title;
    return () => { document.title = 'Nodeloom'; };
  }, [room]);

  return (
    <div className={styles.focusedApp}>
      <div className={styles.titlebar}>
        {onExit !== null ? (
          <button type="button" className={styles.titlebarBtn} aria-label="Exit focus" title="Exit focus" onClick={onExit}>
            <ArrowLeft size={16} />
          </button>
        ) : null}
        <div className={styles.titlebarSpacer} />
        <div className={styles.winControls}>
          <button type="button" className={styles.winBtn} aria-label="Minimize" onClick={() => void desk.windowControl('minimize')}>
            <Minus size={14} />
          </button>
          <button type="button" className={styles.winBtn} aria-label="Maximize or restore" onClick={() => void desk.windowControl('maximize')}>
            <Square size={12} />
          </button>
          <button
            type="button"
            className={`${styles.winBtn} ${styles.winBtnClose}`}
            aria-label="Close"
            onClick={() => void desk.windowControl('close')}
          >
            <X size={15} />
          </button>
        </div>
      </div>
      {failure !== undefined ? (
        <div className={styles.focusedEmpty}>could not open this screen — {failure}</div>
      ) : room === undefined ? (
        <div className={styles.focusedEmpty} />
      ) : (
        <>
          <div className={styles.focusedScene}>
            <SceneScreen sceneId={room.sceneId} />
          </div>
          {room.hasAssistant ? (
            <Console
              room={{ threadId: room.threadId, title: room.title }}
              mode={mode} sticky={sticky} onMode={setMode} onSticky={setSticky}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
