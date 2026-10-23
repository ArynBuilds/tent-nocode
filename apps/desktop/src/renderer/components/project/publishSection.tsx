import { useState } from 'react';
import { desk } from '../../lib/desk.js';
import { slugify } from '../../lib/slug.js';
import { ExportCeremony, allScreens, selectionSummary, type CeremonySelection } from './ExportCeremony.js';
import { ConfirmAction, Empty, Group, IDLE, Row, SectionHead, StatusLine, errorText, kit, type RowState } from '../kit/kit.js';
import type { ProjectNavItem } from './projectNav.js';
import type { LoadedProject } from './ProjectScreen.js';

// Publish to the server on this computer: its name in the address, the front page, what travels.

export function PublishSection({ item, orgId, project }: { item: ProjectNavItem; orgId: string; project: LoadedProject }) {
  const slugs = project.screens.map((s) => s.slug);
  const [slug, setSlug] = useState(() => slugify(project.name));
  const [sel, setSel] = useState<CeremonySelection>(() => allScreens(slugs));
  const [choosing, setChoosing] = useState(false);
  const [entry, setEntry] = useState(slugs[0] ?? '');
  const [state, setState] = useState<RowState>(IDLE);
  const [downState, setDownState] = useState<RowState>(IDLE);

  if (project.screens.length === 0) {
    return (
      <>
        <SectionHead title={item.label} description={item.description} />
        <Group>
          <Empty>Nothing to publish yet. Add a screen in the editor, then come back here.</Empty>
        </Group>
      </>
    );
  }

  const picked = project.screens.filter((s) => sel.scenes.includes(s.slug));
  const front = picked.some((s) => s.slug === entry) ? entry : (picked[0]?.slug ?? '');
  const working = state.phase === 'working';

  const publish = (): void => {
    setDownState(IDLE);
    setState({ phase: 'working', sentence: `Publishing ${project.name}…` });
    void desk.publishWebsite(orgId, {
      appSlug: slug, appTitle: project.name, sceneSlugs: sel.scenes,
      ...(sel.inlineDatasets.length > 0 ? { inlineDatasets: sel.inlineDatasets } : {}),
      ...(front !== '' ? { entrySceneSlug: front } : {}),
      projectId: project.id,
    }).then((res) => {
      if (res.ok && res.data) {
        setState({
          phase: 'done',
          sentence: res.data.alreadyPublished ? 'Nothing changed since the last publish. It is live at:' : 'Published. It is live at:',
          url: res.data.url,
        });
      } else setState({ phase: 'failed', sentence: 'Could not publish.', detail: res.ok ? 'The server gave no address back.' : res.error });
    }).catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not publish.', detail: errorText(err) }));
  };

  const takeDown = async (): Promise<void> => {
    setState(IDLE);
    try {
      const res = await desk.unpublishWebsite(orgId, slug);
      if (res.ok) setDownState({ phase: 'done', sentence: `${slug} is offline. Publish again any time.` });
      else setDownState({ phase: 'failed', sentence: 'Could not take it offline.', detail: res.error });
    } catch (err) {
      setDownState({ phase: 'failed', sentence: 'Could not take it offline.', detail: errorText(err) });
    }
  };

  return (
    <>
      <SectionHead title={item.label} description={item.description} />
      <Group title="Address">
        <Row
          label="Address name"
          htmlFor="publish-slug"
          stack
          hint={<>Lowercase letters, numbers and hyphens. It opens at <code>{slug || 'name'}.localhost:4700</code> on this computer.</>}
        >
          <input
            id="publish-slug"
            className={`${kit.input} ${kit.mono}`}
            value={slug}
            spellCheck={false}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            onBlur={() => { if (slug !== '') setSlug(slugify(slug)); }}
          />
        </Row>
        {picked.length > 1 ? (
          <Row label="Front page" htmlFor="publish-front" hint="The screen people see first.">
            <select id="publish-front" className={kit.select} value={front} onChange={(e) => setEntry(e.target.value)}>
              {picked.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}
            </select>
          </Row>
        ) : null}
      </Group>
      <Group title="What to include">
        <Row label={selectionSummary(sel, slugs.length)}>
          <button type="button" className={`${kit.btn} ${kit.btnQuiet}`} aria-expanded={choosing} onClick={() => setChoosing((v) => !v)}>
            {choosing ? 'Done' : 'Change'}
          </button>
        </Row>
        {choosing ? (
          <ExportCeremony orgId={orgId} projectId={project.id} sceneSlugs={slugs} value={sel} onChange={setSel} withNotes={false} />
        ) : null}
      </Group>
      <Group>
        <Row label="Publish" hint="Publishing again replaces the live version.">
          <button type="button" className={`${kit.btn} ${kit.btnPrimary}`} onClick={publish} disabled={working || slug === '' || sel.scenes.length === 0}>
            {working ? 'Publishing…' : 'Publish'}
          </button>
        </Row>
        {sel.scenes.length === 0 ? <Empty>Tick at least one screen under What to include.</Empty> : null}
        <StatusLine state={state} />
        <Row label="Take it offline" hint="The address stops working until you publish again. Your project is not touched.">
          <ConfirmAction
            label="Take offline"
            prompt={`Take ${slug} offline?`}
            confirmLabel="Take offline"
            workingLabel="Taking offline…"
            disabled={working || slug === ''}
            onConfirm={takeDown}
          />
        </Row>
        <StatusLine state={downState} />
      </Group>
    </>
  );
}
