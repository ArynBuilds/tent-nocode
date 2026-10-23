import type { ExportPreviewEntryDto } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { Empty } from '../kit/kit.js';
import styles from './project.module.css';

// What travels: screens toggle, the parts they need come along locked, table rows and notes opt in.

export interface CeremonySelection {
  scenes: string[];
  inlineDatasets: string[];
  includeNotes: boolean;
}

export function allScreens(sceneSlugs: string[]): CeremonySelection {
  return { scenes: sceneSlugs, inlineDatasets: [], includeNotes: false };
}

/** An entry rides while any selected screen still needs it. */
function rides(e: ExportPreviewEntryDto, scenesOn: string[]): boolean {
  return e.usedBy === undefined || e.usedBy.some((s) => scenesOn.includes(s));
}

function toggle(list: string[], name: string): string[] {
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
}

/** One plain line for a closed selection: "3 of 4 screens, rows from 1 table, notes". */
export function selectionSummary(sel: CeremonySelection, total: number): string {
  const parts = [sel.scenes.length === total ? `All ${total} screen${total === 1 ? '' : 's'}` : `${sel.scenes.length} of ${total} screens`];
  if (sel.inlineDatasets.length > 0) parts.push(`rows from ${sel.inlineDatasets.length} table${sel.inlineDatasets.length === 1 ? '' : 's'}`);
  else parts.push('no table rows');
  if (sel.includeNotes) parts.push('notes');
  return parts.join(', ');
}

function Locked({ items, kind }: { items: ExportPreviewEntryDto[]; kind: string }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.cerGroup}>
      <span className={styles.cerKind}>{kind}</span>
      <div className={styles.cerItems}>
        {items.map((e) => (
          <span key={e.name} className={styles.cerTag} title={e.reason !== undefined ? `${e.reason} - comes along` : 'Comes along with its screen'}>
            {e.title ?? e.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ExportCeremony({ orgId, projectId, sceneSlugs, value, onChange, withNotes = true }: {
  orgId: string;
  projectId?: string;
  sceneSlugs: string[];
  value: CeremonySelection;
  onChange: (sel: CeremonySelection) => void;
  /** Notes travel in a file; a published website has no place for them. */
  withNotes?: boolean;
}) {
  const key = sceneSlugs.join(' ');
  const preview = useQuery(
    `export-preview:${projectId ?? ''}:${key}`,
    () => desk.exportPreview(orgId, { sceneSlugs, ...(projectId !== undefined ? { projectId } : {}) }),
    [orgId, projectId, key],
  );

  if (preview.error !== undefined) return <Empty>Could not read what this project contains: {preview.error}</Empty>;
  if (preview.data === undefined) return <Empty>Reading what this project contains…</Empty>;

  const entries = preview.data.entries;
  const notesCount = preview.data.notesCount;
  const on = value.scenes;
  const screens = entries.filter((e) => e.kind === 'screen');
  const tools = entries.filter((e) => e.kind === 'operation' && rides(e, on));
  const tables = entries.filter((e) => e.kind === 'table' && rides(e, on));
  const components = entries.filter((e) => e.kind === 'library-item' && rides(e, on));
  const set = (patch: Partial<CeremonySelection>): void => onChange({ ...value, ...patch });

  return (
    <div className={styles.ceremony}>
      <div className={styles.cerGroup}>
        <span className={styles.cerKind}>Screens</span>
        <div className={styles.cerItems}>
          {screens.length === 0 ? <span className={styles.cerNone}>No screens yet</span> : screens.map((s) => (
            <label key={s.name} className={styles.cerCheck}>
              <input type="checkbox" checked={on.includes(s.name)} onChange={() => set({ scenes: toggle(on, s.name) })} />
              <span>{s.title ?? s.name}</span>
            </label>
          ))}
        </div>
      </div>
      <Locked kind="Tools" items={tools} />
      <Locked kind="Components" items={components} />
      {tables.length > 0 ? (
        <div className={styles.cerGroup}>
          <span className={styles.cerKind}>Tables</span>
          <div className={styles.cerItems}>
            {tables.map((t) => (
              <span key={t.name} className={styles.cerTable}>
                <span className={styles.cerTag} title={t.reason !== undefined ? `${t.reason} - comes along` : 'Comes along with its screen'}>
                  {t.title ?? t.name}
                </span>
                {(t.totalRows ?? 0) > 0 ? (
                  <label className={styles.cerCheck}>
                    <input
                      type="checkbox"
                      checked={value.inlineDatasets.includes(t.name)}
                      onChange={() => set({ inlineDatasets: toggle(value.inlineDatasets, t.name) })}
                    />
                    <span>with its {t.totalRows} row{t.totalRows === 1 ? '' : 's'}</span>
                  </label>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {withNotes && notesCount > 0 ? (
        <div className={styles.cerGroup}>
          <span className={styles.cerKind}>Notes</span>
          <div className={styles.cerItems}>
            <label className={styles.cerCheck}>
              <input type="checkbox" checked={value.includeNotes} onChange={() => set({ includeNotes: !value.includeNotes })} />
              <span>Project notes <span className={styles.cerCount}>({notesCount})</span></span>
            </label>
          </div>
        </div>
      ) : null}
      <div className={styles.cerHint}>Tools, components and tables the ticked screens use always come along. Table rows stay behind unless you tick them.</div>
    </div>
  );
}
