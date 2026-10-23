import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileCode2, FolderOpen, MessageSquareText, Play, Plus, Save, Wrench } from 'lucide-react';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { store } from '../../lib/canvas/store.js';
import { draftNameValid, freshDraft } from '../../lib/canvas/tools/create/Idle.js';
import { languageFor, mountEditor } from './cmSetup.js';
import type { CmHandle } from './cmSetup.js';
import styles from './code.module.css';
import { EmptyMark } from '../brand/EmptyMark.js';

// The code tab: a list of the project's tools and a way to open a file; picking one opens it full width in the editor.

type Subject =
  | { kind: 'tool'; name: string; version: number; runtime: string }
  | { kind: 'draft'; name: string }
  | { kind: 'file'; path: string };

type Note = { tone: 'quiet' | 'ok' | 'bad'; text: string } | null;

const words = (name: string): string => name.replace(/-/g, ' ');

export function CodeScreen({ projectId, initialOp, draft }: {
  /** Absent = org-wide Tools (a slot-launched code tab has no project context). */
  projectId?: string;
  initialOp?: string;
  draft?: boolean;
}) {
  const { orgId } = useOrg();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cmRef = useRef<CmHandle | null>(null);
  const [tools, setTools] = useState<string[] | null>(null);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [filePath, setFilePath] = useState('');

  // The project's Tools (the same project-scoped read the editor canvas polls).
  useEffect(() => {
    desk.automationGraph(orgId, projectId).then((g) => {
      setTools([...new Set(g.nodes.filter((n) => n.id.startsWith('op:')).map((n) => n.label.replace(/@\d+$/, '')))]);
    }).catch(() => setTools([]));
  }, [orgId, projectId]);

  // Mount CodeMirror once; subjects swap the document in place.
  useEffect(() => {
    if (hostRef.current === null || cmRef.current !== null) return;
    cmRef.current = mountEditor(hostRef.current, { doc: '', language: 'python', onChange: () => setDirty(true) });
    return () => { cmRef.current?.destroy(); cmRef.current = null; };
  }, []);

  async function openTool(name: string): Promise<void> {
    const src = await desk.operationSource(orgId, name);
    if (src === null) { setNote({ tone: 'bad', text: `There is no tool named ${words(name)}.` }); return; }
    setSubject({ kind: 'tool', name: src.name, version: src.version, runtime: src.runtime });
    cmRef.current?.setText(src.code, 'python');
    setDirty(false);
    setNote(null);
  }

  useEffect(() => {
    if (initialOp !== undefined) void openTool(initialOp);
    else if (draft === true) { setSubject(null); setNaming(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOp, draft]);

  function beginDraft(): void {
    const name = draftName.trim();
    if (!draftNameValid(name)) { setNote({ tone: 'bad', text: 'Use lowercase words joined by dashes, for example sum-expenses.' }); return; }
    const d = freshDraft(name);
    setSubject({ kind: 'draft', name });
    cmRef.current?.setText(d.code, 'python');
    setDirty(true);
    setNaming(false);
    setDraftName('');
    setNote(null);
  }

  async function openFile(): Promise<void> {
    const path = filePath.trim();
    if (path === '') return;
    const res = await desk.readFileForView(orgId, path);
    if (!res.ok) { setNote({ tone: 'bad', text: res.error }); return; }
    setSubject({ kind: 'file', path });
    cmRef.current?.setText(res.content, languageFor(path));
    setDirty(false);
    setNote(res.truncated ? { tone: 'quiet', text: 'This file is longer than the editor holds, so the end is cut.' } : null);
  }

  // Save a tool or draft as a new version, or a file through the write permission.
  async function save(): Promise<void> {
    const code = cmRef.current?.getText() ?? '';
    if (subject === null) return;
    if (subject.kind === 'file') {
      const res = await desk.writeFileForEdit(orgId, subject.path, code);
      if (!res.ok) { setNote({ tone: 'bad', text: res.error }); return; }
      setDirty(false);
      setNote({ tone: 'ok', text: 'Saved.' });
      return;
    }
    const draftPayload = subject.kind === 'draft'
      ? { runtime: freshDraft(subject.name).runtime, ioContract: freshDraft(subject.name).ioContract }
      : undefined;
    const res = await desk.registerOperationVersion(orgId, subject.name, code, draftPayload, projectId);
    if (!res.ok) { setNote({ tone: 'bad', text: res.error }); return; }
    if (res.data) {
      setSubject({ kind: 'tool', name: res.data.name, version: res.data.version, runtime: draftPayload?.runtime ?? 'wasm' });
      setDirty(false);
      setNote({ tone: 'ok', text: `Saved as version ${res.data.version}.` });
      if (tools !== null && !tools.includes(res.data.name)) setTools([...tools, res.data.name]);
    }
  }

  // Queue a run through the standard dispatch.
  async function run(): Promise<void> {
    if (subject === null || subject.kind === 'file') return;
    const res = await desk.humanRunOperation(orgId, subject.name, {}, projectId);
    setNote(res.ok ? { tone: 'ok', text: 'Running. The result appears on the canvas when it lands.' } : { tone: 'bad', text: res.error });
  }

  function askAboutSelection(): void {
    const sel = cmRef.current?.selection();
    if (!sel || subject === null) { setNote({ tone: 'quiet', text: 'Select some lines first.' }); return; }
    const label = subject.kind === 'file' ? subject.path
      : subject.kind === 'tool' ? `tool ${subject.name}@${subject.version}` : `draft ${subject.name}`;
    store.armCodeSelection({ subject: label, fromLine: sel.fromLine, toLine: sel.toLine, text: sel.text });
    setNote({ tone: 'ok', text: 'The selected lines go with your next message in the chat.' });
  }

  const back = (): void => { setSubject(null); setNote(null); };
  const noteLine = note !== null ? <div className={`${styles.note} ${styles[note.tone]}`} role="status">{note.text}</div> : null;

  return (
    <div className={styles.code}>
      {subject === null ? (
        <div className={styles.list}>
          <header className={styles.head}>
            <div className={styles.title}>Code</div>
            <p className={styles.lead}>Tools are small programs your flows can run. You can also open any file the app may read.</p>
          </header>

          <section className={styles.group}>
            <div className={styles.groupTitle}>Tools</div>
            <div className={styles.panel}>
              {tools === null ? <div className={styles.empty}>Loading…</div> : null}
              {tools !== null && tools.length === 0 && !naming ? <EmptyMark compact line="No tools in this project yet." /> : null}
              {(tools ?? []).map((t) => (
                <button key={t} type="button" className={styles.row} onClick={() => void openTool(t)}>
                  <span className={styles.rowIcon}><Wrench size={14} /></span>
                  <span className={styles.rowName}>{words(t)}</span>
                  <span className={styles.rowHint}>Open</span>
                </button>
              ))}
              {naming ? (
                <form className={styles.naming} onSubmit={(e) => { e.preventDefault(); beginDraft(); }}>
                  <input
                    className={styles.input}
                    autoFocus
                    spellCheck={false}
                    aria-label="Tool name"
                    placeholder="sum-expenses"
                    value={draftName}
                    onChange={(e) => { setDraftName(e.target.value); setNote(null); }}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); setDraftName(''); } }}
                  />
                  <button type="submit" className={styles.primary} disabled={draftName.trim() === ''}>Create</button>
                </form>
              ) : (
                <button type="button" className={styles.row} onClick={() => { setNaming(true); setNote(null); }}>
                  <span className={styles.rowIcon}><Plus size={14} /></span>
                  <span className={styles.rowName}>New tool</span>
                </button>
              )}
            </div>
          </section>

          <section className={styles.group}>
            <div className={styles.groupTitle}>Open a file</div>
            <form className={`${styles.panel} ${styles.naming}`} onSubmit={(e) => { e.preventDefault(); void openFile(); }}>
              <input
                className={`${styles.input} ${styles.mono}`}
                spellCheck={false}
                aria-label="File path"
                placeholder="Paste a file path"
                value={filePath}
                onChange={(e) => { setFilePath(e.target.value); setNote(null); }}
              />
              <button type="submit" className={styles.secondary} disabled={filePath.trim() === ''}>
                <FolderOpen size={14} />
                Open
              </button>
            </form>
          </section>
          {noteLine}
        </div>
      ) : (
        <div className={styles.bar}>
          <button type="button" className={styles.iconBtn} aria-label="Back to the list" title="Back to the list" onClick={back}>
            <ArrowLeft size={15} />
          </button>
          <span className={styles.subjectIcon}>{subject.kind === 'file' ? <FileCode2 size={15} /> : <Wrench size={15} />}</span>
          <span className={styles.subject} title={subject.kind === 'file' ? subject.path : subject.name}>
            {subject.kind === 'file' ? subject.path.replace(/^.*[\\/]/, '') : words(subject.name)}
          </span>
          <span className={styles.chip}>
            {subject.kind === 'file' ? 'File' : subject.kind === 'draft' ? 'Draft' : `Version ${subject.version}`}
          </span>
          {dirty ? <span className={styles.dirty} title="Unsaved changes" /> : null}
          <span className={styles.barTools}>
            <button type="button" className={styles.ghost} onClick={askAboutSelection} title="Send the selected lines to the chat">
              <MessageSquareText size={14} />
              <span>Ask</span>
            </button>
            {subject.kind !== 'file' ? (
              <button type="button" className={styles.ghost} onClick={() => void run()} title="Run this tool">
                <Play size={14} />
                <span>Run</span>
              </button>
            ) : null}
            <button type="button" className={styles.primary} disabled={!dirty} onClick={() => void save()}>
              <Save size={14} />
              <span>{subject.kind === 'file' ? 'Save' : 'Save version'}</span>
            </button>
          </span>
        </div>
      )}
      {subject !== null ? noteLine : null}
      <div ref={hostRef} className={subject === null ? styles.editorHidden : styles.editorHost} />
    </div>
  );
}
