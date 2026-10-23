import { useEffect, useRef, useState } from 'react';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { store } from '../../lib/canvas/store.js';
import { draftNameValid, freshDraft } from '../../lib/canvas/tools/create/Idle.js';
import { languageFor, mountEditor } from './cmSetup.js';
import type { CmHandle } from './cmSetup.js';
import styles from './code.module.css';

// Code editor tab for operations, hand-written scripts, and userland files.

type Subject =
  | { kind: 'tool'; name: string; version: number; runtime: string }
  | { kind: 'draft'; name: string }
  | { kind: 'file'; path: string };

export function CodeScreen({ projectId, initialOp, draft }: {
  /** R0: absent = org-wide Tools (a slot-launched code tab has no project context). */
  projectId?: string;
  initialOp?: string;
  draft?: boolean;
}) {
  const { orgId } = useOrg();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cmRef = useRef<CmHandle | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [filePath, setFilePath] = useState('');
  const [runNote, setRunNote] = useState<string | null>(null);

  // The project's Tools (the same project-scoped read the editor canvas polls).
  useEffect(() => {
    desk.automationGraph(orgId, projectId).then((g) => {
      const names = [...new Set(g.nodes.filter((n) => n.id.startsWith('op:')).map((n) => n.label.replace(/@\d+$/, '')))];
      setTools(names);
    }).catch(() => undefined);
  }, [orgId, projectId]);

  // Mount CodeMirror once; subjects swap the document in place.
  useEffect(() => {
    if (hostRef.current === null || cmRef.current !== null) return;
    cmRef.current = mountEditor(hostRef.current, { doc: '', language: 'python', onChange: () => setDirty(true) });
    return () => { cmRef.current?.destroy(); cmRef.current = null; };
  }, []);

  async function openTool(name: string): Promise<void> {
    const src = await desk.operationSource(orgId, name);
    if (src === null) { setNote(`no tool named '${name}'`); return; }
    setSubject({ kind: 'tool', name: src.name, version: src.version, runtime: src.runtime });
    cmRef.current?.setText(src.code, 'python');
    setDirty(false);
    setNote(null);
  }

  useEffect(() => {
    if (initialOp !== undefined) void openTool(initialOp);
    else if (draft === true) startDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOp, draft]);

  function startDraft(): void {
    setSubject(null);
    setDraftName('');
    setNote('name the new tool below, kebab-case');
  }

  function beginDraft(name: string): void {
    const d = freshDraft(name);
    setSubject({ kind: 'draft', name });
    cmRef.current?.setText(d.code, 'python');
    setDirty(true);
    setNote(null);
  }

  async function openFile(path: string): Promise<void> {
    const res = await desk.readFileForView(orgId, path);
    if (!res.ok) { setNote(res.error); return; }
    setSubject({ kind: 'file', path });
    cmRef.current?.setText(res.content, languageFor(path));
    setDirty(false);
    setNote(res.truncated ? 'this file is longer than the editor holds — the tail is cut' : null);
  }

  // Save tool/draft as new version or file through write permission.
  async function save(): Promise<void> {
    const code = cmRef.current?.getText() ?? '';
    if (subject === null) return;
    if (subject.kind === 'file') {
      const res = await desk.writeFileForEdit(orgId, subject.path, code);
      if (!res.ok) { setNote(res.error); return; }
      setDirty(false);
      setNote('saved');
      return;
    }
    const draftPayload = subject.kind === 'draft'
      ? { runtime: freshDraft(subject.name).runtime, ioContract: freshDraft(subject.name).ioContract }
      : undefined;
    const res = await desk.registerOperationVersion(orgId, subject.name, code, draftPayload, projectId);
    if (!res.ok) { setNote(res.error); return; }
    if (res.data) {
      setSubject({ kind: 'tool', name: res.data.name, version: res.data.version, runtime: draftPayload?.runtime ?? 'wasm' });
      setDirty(false);
      setNote(`saved version ${res.data.version}`);
      if (!tools.includes(res.data.name)) setTools([...tools, res.data.name]);
    }
  }

  // Queue operation run through standard dispatch.
  async function run(): Promise<void> {
    if (subject === null || subject.kind === 'file') return;
    const res = await desk.humanRunOperation(orgId, subject.name, {}, projectId);
    setRunNote(res.ok ? 'queued — the Result appears on the canvas when it lands' : res.error);
    window.setTimeout(() => setRunNote(null), 6000);
  }

  function askAboutSelection(): void {
    const sel = cmRef.current?.selection();
    if (!sel || subject === null) { setNote('select some lines first'); return; }
    const label = subject.kind === 'file' ? subject.path
      : subject.kind === 'tool' ? `tool ${subject.name}@${subject.version}` : `draft ${subject.name}`;
    store.armCodeSelection({ subject: label, fromLine: sel.fromLine, toLine: sel.toLine, text: sel.text });
    setNote('the selection rides your next ask — the console is a keystroke away');
  }

  return (
    <div className={styles.code}>
      <aside className={styles.rail}>
        <div className={styles.railTitle}>Tools</div>
        {tools.map((t) => (
          <button
            key={t}
            type="button"
            className={subject !== null && subject.kind !== 'file' && subject.name === t ? `${styles.railRow} ${styles.railRowOn}` : styles.railRow}
            onClick={() => void openTool(t)}
          >
            {t.replace(/-/g, ' ')}
          </button>
        ))}
        <button type="button" className={styles.railRow} onClick={startDraft}>+ new tool</button>
        {subject === null && note !== null ? (
          <input
            className={styles.railInput}
            autoFocus
            placeholder="tool-name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && draftNameValid(draftName)) beginDraft(draftName); }}
          />
        ) : null}
        <div className={styles.railTitle}>Files</div>
        <input
          className={styles.railInput}
          placeholder="open a file — paste its path"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && filePath.trim() !== '') void openFile(filePath.trim()); }}
        />
      </aside>
      <div className={styles.main}>
        <div className={styles.bar}>
          <button type="button" className={styles.crumbBtn} onClick={() => window.history.back()}>
            ‹ back
          </button>
          <span className={styles.subject}>
            {subject === null ? '' : subject.kind === 'file' ? subject.path
              : subject.kind === 'tool' ? `${subject.name.replace(/-/g, ' ')} · version ${subject.version} · sealed` : `${subject.name.replace(/-/g, ' ')} · draft`}
          </span>
          <span className={styles.barTools}>
            <button type="button" className={styles.barBtn} onClick={askAboutSelection}>Ask about this</button>
            {subject !== null && subject.kind !== 'file' ? (
              <button type="button" className={styles.barBtn} onClick={() => void run()}>Run</button>
            ) : null}
            <button type="button" className={styles.barBtn} disabled={!dirty || subject === null} onClick={() => void save()}>
              {subject?.kind === 'file' ? 'Save' : 'Save as new version'}
            </button>
          </span>
        </div>
        {note !== null ? <div className={styles.note}>{note}</div> : null}
        {runNote !== null ? <div className={styles.note}>{runNote}</div> : null}
        <div ref={hostRef} className={styles.editorHost} />
      </div>
    </div>
  );
}
