import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { desk } from '../../lib/desk.js';
import { store, useValue } from '../../lib/canvas/store.js';
import { slugify } from '../../lib/slug.js';
import { ExportCeremony, allScreens, type CeremonySelection } from './ExportCeremony.js';
import { Empty, Group, IDLE, Row, SectionHead, StatusLine, errorText, kit, type RowState } from '../kit/kit.js';
import type { ProjectNavItem } from './projectNav.js';
import type { LoadedProject } from './ProjectScreen.js';

// Export: choose what travels, then save one .tproject file through the system save dialog.

export function ExportSection({ item, orgId, project }: { item: ProjectNavItem; orgId: string; project: LoadedProject }) {
  // The canvas document of the project open in the editor travels as its own tickable screen.
  const canvasDoc = useValue('publish.canvasDoc', () => (store.projectId === project.id ? store.canvasDoc.get() : null), [project.id]);
  const screenSlugs = project.screens.map((s) => s.slug);
  const slugs = canvasDoc !== null ? [...screenSlugs, canvasDoc.slug] : screenSlugs;
  const slugKey = slugs.join(' ');
  const [sel, setSel] = useState<CeremonySelection>(() => allScreens(slugs));
  // A canvas document that mounts after opening joins the selection ticked, like every screen.
  useEffect(() => setSel(allScreens(slugKey === '' ? [] : slugKey.split(' '))), [slugKey]);
  const [state, setState] = useState<RowState>(IDLE);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const working = state.phase === 'working';
  const count = sel.scenes.length;

  const save = (): void => {
    setSavedPath(null);
    setState({ phase: 'working', sentence: 'Writing the file…' });
    void desk.exportProjectPackage(orgId, {
      sceneSlugs: sel.scenes,
      fileName: `${slugify(project.name)}.tproject`,
      ...(sel.inlineDatasets.length > 0 ? { inlineDatasets: sel.inlineDatasets } : {}),
      ...(sel.includeNotes ? { notesProjects: [project.name] } : {}),
      projectId: project.id,
    }).then((res) => {
      if (!res.ok || !res.data) {
        setState({ phase: 'failed', sentence: 'Could not write the file.', detail: res.ok ? 'The export gave nothing back.' : res.error });
        return;
      }
      // A dismissed save dialog is a quiet no-op.
      if (res.data.canceled === true) { setState(IDLE); return; }
      setSavedPath(res.data.path);
      setState({ phase: 'done', sentence: 'Saved.' });
    }).catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not write the file.', detail: errorText(err) }));
  };

  return (
    <>
      <SectionHead title={item.label} description={item.description} />
      <Group title="What to include">
        {slugs.length === 0
          ? <Empty>Nothing to export yet. A file carries screens and what they use, so add a screen first.</Empty>
          : <ExportCeremony orgId={orgId} projectId={project.id} sceneSlugs={slugs} value={sel} onChange={setSel} />}
      </Group>
      <Group>
        <Row label="Save as a file" hint="You choose where the file goes. Open it with Nodeloom on any computer to get this project back.">
          <button type="button" className={`${kit.btn} ${kit.btnPrimary}`} onClick={save} disabled={working || count === 0}>
            {working ? 'Exporting…' : `Export ${count} screen${count === 1 ? '' : 's'}`}
          </button>
        </Row>
        <StatusLine state={state} />
        {savedPath !== null ? (
          <div className={kit.copyValue}>
            <code className={kit.copyText}>{savedPath}</code>
            <button type="button" className={`${kit.btn} ${kit.btnQuiet}`} onClick={() => void desk.openPath(orgId, savedPath)}>
              <FolderOpen size={14} />
              <span>Show in folder</span>
            </button>
          </div>
        ) : null}
      </Group>
    </>
  );
}
