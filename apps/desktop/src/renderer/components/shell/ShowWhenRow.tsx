import { useState } from 'react';
import type { SceneBinding } from '@tent-nocode/core';
import type { ComponentCatalogEntry } from '../../../shared/ipc.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { elementNoun, emitWord, paramWord } from '../../lib/page-edit/flowWires.js';
import type { SceneOpLike } from '../../lib/canvas/history.js';

/** One edit the host commits: the ops and their inverse. */
export interface GestureEdit { ops: SceneOpLike[]; inverse: SceneOpLike[]; guards: Array<{ nodeId: string; component: string; key: string; expected: unknown }>; label: string; sceneSlug?: string }
const compileParamEdit = (input: { nodeId: string; component: string; key: string; value: unknown; storedPayload: Record<string, unknown> }): GestureEdit => ({
  ops: [{ op: 'set_property', node: input.nodeId, component: input.component, key: input.key, value: input.value }],
  inverse: input.key in input.storedPayload
    ? [{ op: 'set_property', node: input.nodeId, component: input.component, key: input.key, value: input.storedPayload[input.key] }]
    : [{ op: 'set_component', node: input.nodeId, component: input.component, value: { ...input.storedPayload } }],
  guards: [{ nodeId: input.nodeId, component: input.component, key: input.key, expected: input.value }],
  label: `${input.key} on ${input.component}`,
});
const compileParamClear = (input: { nodeId: string; ref: string; key: string; stored: Record<string, unknown> }): GestureEdit | null => {
  if (!(input.key in input.stored)) return null;
  const next = { ...input.stored };
  delete next[input.key];
  return {
    ops: [{ op: 'set_component', node: input.nodeId, component: input.ref, value: next }],
    inverse: [{ op: 'set_component', node: input.nodeId, component: input.ref, value: { ...input.stored } }],
    guards: [], label: `clear ${input.key}`,
  };
};
/** A typed value from the field's text: JSON where it parses, the raw words otherwise. */
const parseParamValue = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return raw; } };
import styles from './sidepanel.module.css';

/**
 * F30 (2026-08-16, the visible-machinery arc): THE SHOW-WHEN ROW - the write
 * side of the @26 engine's generalized `when` gate, one plain-word row in the
 * Behavior section of EVERY element. Unset = the ghost "Show when..." offer
 * (zero space beyond it - the add-to-set grammar); set = a live row speaking
 * the condition in plain words with an x back to always-shown. The dropdown
 * offers the three gate sources: an in-scope collecting input (the FiresRow
 * subtree-walk idiom), an emit-declaring element's channel, and a declared
 * binding's facts (has rows / is empty / a column's value). The pick writes
 * the component's reserved `when` param through compileParamEdit and the one
 * commit path; the x clears through compileParamClear (the standing x lane -
 * a set_property carrying undefined would refuse at the wall). Machine ids
 * ride the stored value only - the words are nouns, field words, and column
 * display words, never ids.
 */

export interface ShowWhenSources {
  /** In-scope collecting inputs - the field word + the element's noun. */
  params: Array<{ param: string; noun: string }>;
  /** Emit-declaring elements - the node id rides the VALUE, the noun the words. */
  emits: Array<{ node: string; noun: string; emit: string }>;
  /** The scene's declared binding names. */
  bindings: string[];
  /** Column words per dataset binding (other kinds offer the row facts alone). */
  columns: Record<string, Array<{ key: string; display: string }>>;
}

export interface ShowWhenOption {
  id: string;
  sentence: string;
  needsValue: boolean;
  compose: (is: unknown) => Record<string, unknown>;
}

/** The dropdown's condition list - every sentence plain words (exported for tests). */
export function showWhenOptions(src: ShowWhenSources): ShowWhenOption[] {
  const out: ShowWhenOption[] = [];
  for (const p of src.params) {
    out.push({
      id: `param:${p.param}`,
      sentence: `${paramWord(p.param)} (the ${p.noun}) is…`,
      needsValue: true,
      compose: (is) => ({ param: p.param, is }),
    });
  }
  for (const e of src.emits) {
    out.push({
      id: `emit:${e.node}.${e.emit}`,
      sentence: `the ${e.noun}'s ${emitWord(e.emit)} is…`,
      needsValue: true,
      compose: (is) => ({ from: `${e.node}.${e.emit}`, is }),
    });
  }
  for (const b of src.bindings) {
    out.push({ id: `rows:${b}`, sentence: `${paramWord(b)} has rows`, needsValue: false, compose: () => ({ binding: b, 'has-rows': true }) });
    out.push({ id: `empty:${b}`, sentence: `${paramWord(b)} is empty`, needsValue: false, compose: () => ({ binding: b, 'has-rows': false }) });
    for (const c of src.columns[b] ?? []) {
      out.push({
        id: `col:${b}:${c.key}`,
        sentence: `${paramWord(b)}'s ${c.display} is…`,
        needsValue: true,
        compose: (is) => ({ binding: b, column: c.key, is }),
      });
    }
  }
  return out;
}

/** A stored `when` back to its option id; unrecognized shapes read null (shown). */
export function optionIdOf(when: unknown): string | null {
  if (when === null || typeof when !== 'object' || Array.isArray(when)) return null;
  const r = when as Record<string, unknown>;
  if (typeof r['param'] === 'string') return `param:${r['param']}`;
  if (typeof r['from'] === 'string') return `emit:${r['from']}`;
  if (typeof r['binding'] === 'string') {
    if (typeof r['column'] === 'string') return `col:${r['binding']}:${r['column']}`;
    if (r['has-rows'] === true) return `rows:${r['binding']}`;
    if (r['has-rows'] === false) return `empty:${r['binding']}`;
  }
  return null;
}

/** The stored compared value as editable text ('' where the shape carries none). */
export function whenIsText(when: unknown): string {
  if (when === null || typeof when !== 'object' || Array.isArray(when)) return '';
  const is = (when as Record<string, unknown>)['is'];
  return is === undefined ? '' : String(is);
}

interface SubtreeNode { id: string; components: Record<string, Record<string, unknown>>; children?: unknown }

/** The scene's collecting inputs, one option per distinct field (the FiresRow walk). */
export function paramSourcesOf(subtree: unknown): Array<{ param: string; noun: string }> {
  const out: Array<{ param: string; noun: string }> = [];
  const seen = new Set<string>();
  const walk = (n: SubtreeNode): void => {
    for (const payload of Object.values(n.components)) {
      const p = payload['param'];
      if (typeof p === 'string' && p !== '' && !seen.has(p)) {
        seen.add(p);
        out.push({ param: p, noun: elementNoun(n) });
      }
    }
    if (Array.isArray(n.children)) for (const kid of n.children) walk(kid as SubtreeNode);
  };
  if (subtree !== null && typeof subtree === 'object') walk(subtree as SubtreeNode);
  return out;
}

/** The scene's emit-declaring elements - declared emits from the one catalog. */
export function emitSourcesOf(subtree: unknown, catalog: ComponentCatalogEntry[]): Array<{ node: string; noun: string; emit: string }> {
  const out: Array<{ node: string; noun: string; emit: string }> = [];
  const walk = (n: SubtreeNode): void => {
    for (const ref of Object.keys(n.components)) {
      const cat = catalog.find((c) => c.ref === ref);
      for (const e of cat?.emits ?? []) out.push({ node: n.id, noun: elementNoun(n), emit: e.name });
    }
    if (Array.isArray(n.children)) for (const kid of n.children) walk(kid as SubtreeNode);
  };
  if (subtree !== null && typeof subtree === 'object') walk(subtree as SubtreeNode);
  return out;
}

export function ShowWhenRow({ sceneSlug, nodeId, refKey, stored, catalog, projectId, onEdit }: {
  sceneSlug: string;
  nodeId: string;
  refKey: string;
  stored: Record<string, unknown>;
  catalog: ComponentCatalogEntry[];
  projectId: string | null;
  onEdit: (edit: GestureEdit) => void;
}) {
  const { orgId } = useOrg();
  const [open, setOpen] = useState(false);
  const subQ = useQuery(
    `showWhenNodes:${sceneSlug}`,
    () => desk.sceneSubtree(orgId, sceneSlug, 'root', 8).catch(() => ({ revision: 0, subtree: null, truncated: false })),
    [orgId, sceneSlug],
  );
  const bindsQ = useQuery(
    `showWhenBinds:${sceneSlug}`,
    () => desk.sceneBindings(orgId, sceneSlug).catch(() => [] as SceneBinding[]),
    [orgId, sceneSlug],
  );
  useLive(['scenes'], bindsQ.refetch);
  const datasets = (bindsQ.data ?? []).flatMap((b) => (b.kind === 'query' ? [{ name: b.name, dataset: b.table }] : []));
  const briefKey = datasets.map((d) => d.name).join(',');
  const briefsQ = useQuery(
    `showWhenCols:${sceneSlug}:${briefKey}`,
    () => Promise.all(datasets.map(async (d) => {
      const brief = await desk.datasetBrief(orgId, d.dataset, projectId ?? undefined).catch(() => null);
      return [d.name, (brief?.columns ?? []).map((c) => ({ key: c.key, display: c.display }))] as const;
    })),
    [orgId, sceneSlug, briefKey],
  );
  const options = showWhenOptions({
    params: paramSourcesOf(subQ.data?.subtree ?? null),
    emits: emitSourcesOf(subQ.data?.subtree ?? null, catalog),
    bindings: (bindsQ.data ?? []).map((b) => b.name),
    columns: Object.fromEntries(briefsQ.data ?? []),
  });

  const current = stored['when'];
  const isSet = 'when' in stored;
  const currentId = optionIdOf(current) ?? '';
  const picked = options.find((o) => o.id === currentId);

  const put = (value: unknown): void =>
    onEdit(compileParamEdit({ nodeId, component: refKey, key: 'when', value, storedPayload: stored }));
  const clear = (): void => {
    setOpen(false);
    const edit = compileParamClear({ nodeId, ref: refKey, key: 'when', stored });
    if (edit !== null) onEdit(edit);
  };
  const pick = (id: string): void => {
    if (id === '') { clear(); return; }
    const opt = options.find((o) => o.id === id);
    if (opt === undefined) return;
    // A source switch keeps the typed value; the row facts need none.
    put(opt.compose(parseParamValue(whenIsText(current))));
  };

  // Unset and unopened = the ghost offer alone (zero space - the motion-offer idiom).
  if (!isSet && !open) {
    return (
      <button type="button" className={styles.inspectorMotionMore} onClick={() => setOpen(true)}>
        Show when&hellip;
      </button>
    );
  }
  return (
    <div className={styles.inspectorRowStatic}>
      <span className={styles.inspectorKey}>Show when</span>
      <select className={styles.inspectorSelect} value={currentId} onChange={(e) => pick(e.target.value)}>
        <option value="">always</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.sentence}</option>)}
        {/* a condition whose source left the scene still reads honestly (never a blank) */}
        {currentId !== '' && picked === undefined ? (
          <option value={currentId}>a condition on something gone</option>
        ) : null}
      </select>
      {picked?.needsValue === true ? (
        <input
          key={currentId}
          className={styles.inspectorEdit}
          defaultValue={whenIsText(current)}
          placeholder="Value"
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onBlur={(e) => put(picked.compose(parseParamValue(e.target.value)))}
        />
      ) : null}
      {isSet ? (
        <button type="button" className={styles.rowClear} aria-label="Always show this element" title="Always show" onClick={clear}>×</button>
      ) : null}
    </div>
  );
}
