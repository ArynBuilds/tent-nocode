import { closePublishTakeover, usePublishTakeover } from '../../lib/publishTakeover.js';
import { Takeover, useTakeoverEscape } from '../kit/SettingsPage.js';
import { ProjectScreen } from './ProjectScreen.js';

// Full-screen project screen covering everything under the titlebar; the screens underneath stay mounted.
export function PublishTakeover() {
  const takeover = usePublishTakeover();
  useTakeoverEscape(takeover !== null, closePublishTakeover);
  if (takeover === null) return null;
  return (
    <Takeover>
      <ProjectScreen
        key={`${takeover.projectId}:${takeover.section ?? ''}`}
        projectId={takeover.projectId}
        {...(takeover.section !== undefined ? { section: takeover.section } : {})}
        onClose={closePublishTakeover}
      />
    </Takeover>
  );
}
