import { useEffect } from 'react';
import { closePublishTakeover, usePublishTakeover } from '../../lib/publishTakeover.js';
import { ProjectScreen } from './ProjectScreen.js';
import styles from './project.module.css';

// Full-screen project screen covering everything under the titlebar; the screens underneath stay mounted.
export function PublishTakeover() {
  const takeover = usePublishTakeover();

  // Esc closes this takeover only (capture + stopPropagation); a control holding its own Esc keeps it.
  useEffect(() => {
    if (takeover === null) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (e.target instanceof Element && e.target.closest('[data-own-escape]') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      closePublishTakeover();
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [takeover]);

  if (takeover === null) return null;
  return (
    <div className={`${styles.takeover} ${styles.scaleUp}`} data-scroll-root="">
      <ProjectScreen
        key={`${takeover.projectId}:${takeover.section ?? ''}`}
        projectId={takeover.projectId}
        {...(takeover.section !== undefined ? { section: takeover.section } : {})}
        onClose={closePublishTakeover}
      />
    </div>
  );
}
