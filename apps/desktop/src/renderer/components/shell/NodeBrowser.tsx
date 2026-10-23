import { useEffect, useState } from 'react';
import { Plug, Shapes, Workflow } from 'lucide-react';
import { PRIMITIVES, citizenWord, elementPortRule, legalTargets } from '@tent-nocode/core';
import type { PrimitiveName } from '@tent-nocode/core';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import { INSERT_ROWS, NAMED_INSERTS, kebabName, store, useValue } from '../../lib/canvas/store.js';
import type { AddKind, CatalogAdd, NodeBrowseContext, NodeRecord } from '../../lib/canvas/store.js';
import { usePlaceableDoors, usePlaceableIntegrations, usePlaceableSteps, usePlaceableTriggers } from '../../lib/canvas/placeables.js';
import styles from './sidepanel.module.css';
import { EmptyMark } from '../brand/EmptyMark.js';

// THE NODE BROWSER (Phase 12, row 12.16): citizens and the five in ONE list. A wire question (mode 'wire')
// filters the citizens by the contract - legalTargets for a citizen source, the element-port law for an
// element, the splice for a pair - and offers the doors and the births the question allows; the catalog
// (mode 'catalog') offers everything placeable: the create rows (a Table, Screen or Tool is named in place -
// naming is part of the gesture, never a confirm), the four drawable primitives, the integration
// shelf, the steps, the service doors, the triggers, and the project's own citizens.

function legalKinds(ctx: NodeBrowseContext): ReadonlySet<string> | null {
  if (ctx.mode !== 'wire') return null;
  const all = ['dataset', 'operation', 'scene', 'trigger', 'integration', 'step', 'role', 'notes', 'chain', 'out'];
  if (ctx.source !== undefined) return new Set(legalTargets(ctx.source.kind) as readonly string[]);
  if (ctx.element !== undefined) { const cls = ctx.element.cls; return new Set(all.filter((k) => elementPortRule(cls, k) !== null)); }
  if (ctx.between !== undefined) {
    const b = ctx.between;
    return new Set(all.filter((k) => (legalTargets(b.fromKind) as readonly string[]).includes(k) && (legalTargets(k) as readonly string[]).includes(b.toKind)));
  }
  return new Set(all);
}

export function NodeBrowser({ context }: { context: NodeBrowseContext }) {
  const { orgId } = useOrg();
  const { focusedProjectId } = useFocusedProject();
  const catalogMode = context.mode === 'catalog';
  const projectId = catalogMode ? focusedProjectId : context.projectId;
  const nodes = useValue('browser.nodes', () => store.nodes.get(), []);
  const integrations = usePlaceableIntegrations(orgId, { projectId });
  const steps = usePlaceableSteps();
  const doors = usePlaceableDoors(orgId, { projectId });
  const triggers = usePlaceableTriggers(orgId, { projectId });
  const [query, setQuery] = useState('');
  const [quiet, setQuiet] = useState<string | null>(null);
  // The named births: the open create row and the words typed into it.
  const [naming, setNaming] = useState<AddKind | null>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => { setQuery(''); setQuiet(null); setNaming(context.naming ?? null); setTyped(''); }, [context]);

  const q = query.trim().toLowerCase();
  const hit = (s: string): boolean => q === '' || s.toLowerCase().includes(q);
  const legal = legalKinds(context);
  const citizens = nodes.filter((n) => !n.id.startsWith('fold:') && n.id !== context.source?.id && (legal === null || legal.has(n.kind)) && hit(n.label));
  const byKind = new Map<string, NodeRecord[]>();
  for (const n of citizens) byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), n]);

  const add = (a: CatalogAdd): void => { if (!store.requestCatalogAdd(a)) setQuiet('Open the workspace to place it.'); };
  // A named insert asks for its words first; the kebab name is minted for the human, the words survive on the card.
  const insert = (kind: AddKind): void => {
    if (NAMED_INSERTS.has(kind)) { setNaming(kind); setTyped(''); return; }
    if (catalogMode || context.onPick === undefined) add({ kind }); else context.onPick({ pick: 'insert', kind }, context);
  };
  const finalName = naming === 'table' ? kebabName(typed) : typed.trim();
  const named = (): void => {
    if (naming === null || finalName.length === 0) return;
    const kind = naming;
    setNaming(null); setTyped('');
    if (catalogMode || context.onPick === undefined) add({ kind, name: finalName, typed: typed.trim() });
    else context.onPick({ pick: 'insert', kind, name: finalName, typed: typed.trim() }, context);
  };
  const pickNode = (n: NodeRecord): void => {
    if (catalogMode || context.onPick === undefined) { if (!store.requestNodeProps(n.id)) setQuiet('Open the workspace to see it.'); return; }
    context.onPick({ pick: 'node', id: n.id, kind: n.kind, label: n.label }, context);
  };
  const row = (key: string, label: string, act: () => void, detail?: string, icon?: React.ReactNode, plus = false): React.ReactNode => (
    <button key={key} type="button" className={styles.nodeBrowserRow} onClick={act}>
      {plus ? <span className={styles.nodeBrowserPlus}>+</span> : icon}
      <span className={styles.nodeBrowserLabel}>{label}</span>
      {detail !== undefined ? <span className={styles.nodeBrowserDetail}>{detail}</span> : null}
    </button>
  );

  // A naming headline holds only while its create row is open.
  const headline = (context.naming !== undefined && naming === null ? undefined : context.headline) ?? (catalogMode ? 'Everything you can place' : context.between !== undefined
    ? `Between ${context.between.fromLabel} and ${context.between.toLabel}`
    : context.element !== undefined ? `What does the ${context.element.label} reach?` : 'What happens next?');

  return (
    <div className={styles.nodeBrowser}>
      <div className={styles.nodeBrowserHead}>{headline}</div>
      <input className={styles.nodeBrowserSearch} placeholder="Search" aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      {quiet !== null ? <div className={styles.nodeBrowserQuiet}>{quiet}</div> : null}
      {context.doors !== undefined && context.doors.length > 0 ? (
        <>
          <div className={styles.nodeBrowserCat}>Doors</div>
          {context.doors.filter((d) => hit(d.word)).map((d) => row(`door:${d.id}`, d.word, () => context.onPick?.({ pick: 'door', id: d.id, word: d.word }, context), d.klass))}
        </>
      ) : null}
      {catalogMode || legal !== null ? (
        <>
          <div className={styles.nodeBrowserCat}>Create</div>
          {INSERT_ROWS.filter((i) => hit(i.word) && (legal === null || legal.has(i.citizenKind))).map((i) => (naming === i.kind ? (
            <div key={`insert:${i.kind}`} className={styles.nodeBrowserNaming}>
              <input
                className={styles.nodeBrowserSearch} autoFocus value={typed}
                aria-label={`Name the ${i.word.slice(4).toLowerCase()}`}
                placeholder={i.kind === 'table' ? 'For example: Monthly costs' : `Name the ${i.word.slice(4).toLowerCase()}`}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') named(); if (e.key === 'Escape') { setNaming(null); setTyped(''); } }}
              />
              <button type="button" className={styles.nodeBrowserAdd} disabled={finalName.length === 0} onClick={named}>Add</button>
            </div>
          ) : row(`insert:${i.kind}`, i.word, () => insert(i.kind), undefined, undefined, true)))}
        </>
      ) : null}
      {catalogMode ? (
        <>
          <div className={styles.nodeBrowserCat}>Screen parts</div>
          {(Object.keys(PRIMITIVES) as PrimitiveName[]).filter((n): n is Exclude<PrimitiveName, 'instance'> => n !== 'instance' && hit(n)).map((n) => row(`prim:${n}`, PRIMITIVES[n].title, () => add({ primitive: n }), PRIMITIVES[n].breath.split(':')[0], <Shapes size={13} />))}
          {integrations.length > 0 ? <div className={styles.nodeBrowserCat}>Connections</div> : null}
          {integrations.filter((i) => hit(i.displayName)).map((i) => row(`intg:${i.name}`, i.displayName, () => add({ integration: i.name }), undefined, <Plug size={13} />))}
          {steps.length > 0 ? <div className={styles.nodeBrowserCat}>Steps</div> : null}
          {steps.filter((s) => hit(s.displayName)).map((s) => row(`step:${s.kind}`, s.displayName, () => add({ step: s.kind }), s.blurb, <Workflow size={13} />))}
          {doors.length > 0 ? <div className={styles.nodeBrowserCat}>Service doors</div> : null}
          {doors.filter((d) => hit(d.displayName)).map((d) => row(`sdoor:${d.service}:${d.endpoint}`, d.displayName, () => add({ door: { service: d.service, endpoint: d.endpoint } }), d.service, <Plug size={13} />))}
          {triggers.length > 0 ? <div className={styles.nodeBrowserCat}>Triggers</div> : null}
          {triggers.filter((t) => hit(t.displayName)).map((t) => row(`trg:${t.service}:${t.trigger}`, t.displayName, () => add({ trigger: { service: t.service, id: t.trigger } }), t.service, <Workflow size={13} />))}
        </>
      ) : null}
      {[...byKind.entries()].map(([kind, rows]) => (
        <div key={kind}>
          <div className={styles.nodeBrowserCat}>{citizenWord(kind)}</div>
          {rows.map((n) => row(n.id, n.word ?? n.label, () => pickNode(n), n.detail ?? undefined))}
        </div>
      ))}
      {citizens.length === 0 && !catalogMode ? <EmptyMark compact line="Nothing on the canvas fits here yet. Create one above." /> : null}
    </div>
  );
}
