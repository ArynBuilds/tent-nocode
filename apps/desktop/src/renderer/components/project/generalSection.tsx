import { useEffect, useRef, useState } from 'react';
import { desk } from '../../lib/desk.js';
import { closePublishTakeover } from '../../lib/publishTakeover.js';
import { ConfirmAction, Group, IDLE, Row, SectionHead, StatusLine, errorText, kit, refusalOf, type RowState } from './kit.js';
import type { ProjectNavItem } from './projectNav.js';
import type { LoadedProject } from './ProjectScreen.js';

// General: the name (saved on Enter or leaving the field), the kind and screen count, and deleting the project.

export function GeneralSection({ item, orgId, project, onRenamed }: {
  item: ProjectNavItem;
  orgId: string;
  project: LoadedProject;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [nameState, setNameState] = useState<RowState>(IDLE);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const clearTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);
  useEffect(() => setName(project.name), [project.name]);

  const save = (): void => {
    const next = name.trim();
    if (next === project.name) return;
    if (next === '') {
      setName(project.name);
      setNameState({ phase: 'failed', sentence: 'A project needs a name. The old name is back.' });
      return;
    }
    setNameState({ phase: 'working', sentence: 'Saving…' });
    void desk.renameProject(orgId, project.id, next).then((res) => {
      const refusal = refusalOf(res);
      if (refusal !== null) { setNameState({ phase: 'failed', sentence: 'Could not rename the project.', detail: refusal }); return; }
      setNameState({ phase: 'done', sentence: 'Saved.' });
      window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => setNameState(IDLE), 2000);
      onRenamed();
    }).catch((err: unknown) => setNameState({ phase: 'failed', sentence: 'Could not rename the project.', detail: errorText(err) }));
  };

  const remove = async (): Promise<void> => {
    setDeleteError(null);
    try {
      const res = await desk.humanDeleteProject(orgId, project.id);
      const refusal = refusalOf(res);
      if (refusal !== null) { setDeleteError(refusal); return; }
      closePublishTakeover();
    } catch (err) {
      setDeleteError(errorText(err));
    }
  };

  const screens = project.screens.length;
  return (
    <>
      <SectionHead title={item.label} description={item.description} />
      <Group title="Project">
        <Row label="Name" htmlFor="project-name" hint="Shown on the dashboard and used as the default file and website name." stack>
          <input
            id="project-name"
            className={kit.input}
            value={name}
            maxLength={120}
            onChange={(e) => { setName(e.target.value); if (nameState.phase === 'failed') setNameState(IDLE); }}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape' && name !== project.name) {
                e.stopPropagation();
                setName(project.name);
              }
            }}
            data-own-escape={name !== project.name ? '' : undefined}
          />
        </Row>
        <StatusLine state={nameState} />
        <Row label="Kind" hint="Set when the project was made.">
          <span className={kit.value}>{project.kind === 'website' ? 'Website' : 'App'}</span>
        </Row>
        <Row label="Screens">
          <span className={kit.value}>{screens === 0 ? 'None yet' : `${screens} screen${screens === 1 ? '' : 's'}`}</span>
        </Row>
      </Group>
      <Group title="Danger zone">
        <Row label="Delete this project" hint="Deletes the project together with its screens, chats, tables and notes.">
          <ConfirmAction
            label="Delete project"
            prompt={`Delete "${project.name}"?`}
            confirmLabel="Delete"
            workingLabel="Deleting…"
            onConfirm={remove}
          />
        </Row>
        {deleteError !== null ? <StatusLine state={{ phase: 'failed', sentence: 'Could not delete the project.', detail: deleteError }} /> : null}
      </Group>
    </>
  );
}
