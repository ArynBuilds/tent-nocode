import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Play, Shapes } from 'lucide-react';
import { PRIMITIVES, datasetGrantPatterns, primitiveRef } from '@tent-nocode/core';
import type { PrimitiveName } from '@tent-nocode/core';
import { desk } from '../../lib/desk.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import { usePlaceableDoors, usePlaceableIntegrations, usePlaceableSteps, usePlaceableTriggers } from '../../lib/canvas/placeables.js';
import { navigate } from '../../lib/router.js';
import { NAMED_INSERTS, canFold, deletableOnMap, descentFor, kindIcon, mintGroup, store, useValue, verbSentence } from '../../lib/canvas/store.js';
import type { AddKind, CatalogAdd, CitizenSelection, CreateArm, EdgeRecord, MenuGroups, NodeBrowseContext, NodeBrowserPick, NodeRecord, Placed, WireSelection } from '../../lib/canvas/store.js';
import type { Doors } from '../../lib/canvas/tools/StateNode.js';
import { deleteMapSelection, dissolveFold, expandFoldSelection, openVerbDoor } from '../../lib/canvas/tools/select/Idle.js';
import type { DeleteConfirm } from '../../lib/canvas/tools/select/Idle.js';
import { attachElement, elementClassOfNode, elementWireOut, pickerLanded, watcherMinted, wireDrop } from '../../lib/canvas/tools/select/DrawingWire.js';
import type { LanePicker, WireLaneDeps } from '../../lib/canvas/tools/select/DrawingWire.js';
import { landCreate, landDataWire } from '../../lib/canvas/tools/create/Drawing.js';
import { draftNameValid, freshDraft } from '../../lib/canvas/tools/create/Idle.js';
import { channelDrop } from '../../lib/page-edit/channelLanes.js';
import { CanvasEngine, activeEditor } from '../canvas/CanvasEngine.js';
import type { EngineDecor } from '../canvas/CanvasEngine.js';
import { CornerLegend } from '../canvas/CornerLegend.js';
import type { CanvasNode } from '../canvas/NodeCard.js';
import { DropRefusal } from '../canvas/WireLayer.js';
import { DropTarget } from '../canvas/DropTarget.js';
import { NodeConfigCard, type ConfigCardState } from '../canvas/NodeConfigCard.js';
import { ModeToolbar } from './ModeToolbar.js';
import { WorkspaceEntered } from './Entered.js';
import type { WorkspaceMenuState } from './ContextMenu.js';
import { WorkspaceOverlays } from './Overlays.js';
import canvasStyles from '../canvas/canvas.module.css';
import styles from '../shell/sidepanel.module.css';

// THE WORKSPACE MOUNT (Phase 12, row 12.16): the store is mounted on the focused project, the engine renders
// its records, and this file supplies what the machine ends in beyond the store - the doors (the kernel's
// citizen births and deletions, the wire lane, the menus, the pickers, the quiet words) and the decor (the
// run badges, the replay, the fold door, the edge doors, the verbs). The runs, the replay and the selection
// sentence are the store's records (the live push and the tick feed them). No poll, no bus, no lane hooks.

const citizenSel = (n: Pick<NodeRecord, 'id' | 'kind' | 'label' | 'projectId'>): CitizenSelection =>
  ({ citizen: true, kind: n.kind, nodeId: n.id, label: n.label, projectId: n.projectId });
const defaultSceneSize = (kind: string | null | undefined): { w: number; h: number } => (kind === 'website' ? { w: 1920, h: 1080 } : { w: 1440, h: 900 });

/** The wire's inspector subject: the sentence, the binding it is, the action wire it is. */
function wireSubject(e: EdgeRecord, byId: ReadonlyMap<string, NodeRecord>, projectId: string | null): WireSelection | null {
  const a = byId.get(e.from); const b = byId.get(e.to);
  if (a === undefined || b === undefined) return null;
  const sentence = `${a.label} ${verbSentence(e.verb)} ${b.label}`;
  const toSlug = store.sceneSlugOf(e.to); const fromSlug = store.sceneSlugOf(e.from);
  if (e.verb === 'shows' && e.from.startsWith('ds:') && toSlug !== null) return { wire: true, sentence, binding: { sceneSlug: toSlug, dataset: a.label, projectId } };
  if (typeof e.action === 'string' && typeof e.rule === 'number' && fromSlug !== null) {
    return { wire: true, sentence, actionWire: { sceneSlug: fromSlug, action: e.action, rule: e.rule, ...(e.param !== undefined ? { param: e.param } : {}), projectId } };
  }
  return { wire: true, sentence };
}

/** The hover x: the declaration comes out through the same door that wrote it. */
function edgeRemover(orgId: string, e: EdgeRecord, byId: ReadonlyMap<string, NodeRecord>, quiet: (s: string) => void): (() => void) | undefined {
  const said = (r: { ok: boolean; error?: string }): void => { if (!r.ok) quiet(r.error ?? 'that would not come out'); };
  const fromSlug = store.sceneSlugOf(e.from); const toSlug = store.sceneSlugOf(e.to);
  if (typeof e.action === 'string' && typeof e.rule === 'number' && fromSlug !== null) {
    const { action, rule, param } = e;
    if (typeof param === 'string') return () => void desk.humanUnmapActionRuleParam(orgId, fromSlug, action, rule, param).then(said);
    return () => void desk.humanRemoveActionRule(orgId, fromSlug, action, rule).then(said);
  }
  if (e.verb === 'shows' && toSlug !== null) { const src = byId.get(e.from); if (src !== undefined) return () => void desk.humanRemoveBinding(orgId, toSlug, src.label).then(said); }
  if (typeof e.via === 'string' && e.via.startsWith('fstep:')) { const [, f, s] = e.via.split(':'); if (f !== undefined && s !== undefined) return () => void desk.flowsRemoveStep(orgId, f, s).then(said); }
  if ((e.from.startsWith('ds:') && e.to.startsWith('fstep:')) || (e.from.startsWith('fstep:') && e.to.startsWith('ds:'))) {
    const [, f, s] = (e.from.startsWith('fstep:') ? e.from : e.to).split(':');
    if (f !== undefined && s !== undefined) return () => void desk.flowsSetStepParams(orgId, f, s, { table: '' }).then(said);
  }
  if (e.from.startsWith('fstep:') && e.to.startsWith('fstep:') && typeof e.port === 'string' && typeof e.slot === 'string') {
    const [, f, from] = e.from.split(':'); const [, , to] = e.to.split(':'); const { port, slot } = e;
    if (f !== undefined && from !== undefined && to !== undefined) return () => void desk.flowsUnwireSteps(orgId, f, from, to, port, slot).then(said);
  }
  if (e.from.startsWith('trg:') || e.to.startsWith('trg:')) { const id = (e.from.startsWith('trg:') ? e.from : e.to).slice(4); return () => void desk.deleteTrigger(orgId, id).catch(() => quiet('the trigger would not come out')); }
  if (e.from.startsWith('chain:') || e.to.startsWith('chain:')) { const id = (e.from.startsWith('chain:') ? e.from : e.to).slice(6); return () => void desk.revokeReactiveChain(orgId, id).catch(() => quiet('the auto-update would not come out')); }
  if (e.verb === 'may-edit') {
    const role = byId.get(e.from); const ds = byId.get(e.to);
    if (role !== undefined && ds !== undefined) return () => void desk.listAgents(orgId).then(async (agents) => { const agent = agents.find((a) => a.slug === role.label); if (agent !== undefined) for (const p of datasetGrantPatterns(ds.label)) await desk.revokeImpact(orgId, agent.id, p); });
  }
  return undefined;
}

export function Workspace({ cluster }: { cluster: { title: string } }) {
  const { orgId } = useOrg();
  const projectId = useFocusedProject().focusedProjectId;
  useEffect(() => { if (projectId === null) return; return store.mount(orgId, projectId); }, [orgId, projectId]);
  useEffect(() => { store.setPanelHosts({ workspace: true }); return () => store.setPanelHosts({ workspace: false }); }, []);

  const nodes = useValue('ws.nodes', () => store.nodes.get(), []);
  const edges = useValue('ws.edges', () => store.edges.get(), []);
  const projects = useValue('ws.projects', () => store.projects.get(), []);
  const selected = useValue('ws.selected', () => store.selectedCardIds(), []);
  const wireSel = useValue('ws.wireSel', () => store.selectedWire(), []);
  const elementSel = useValue('ws.elementSel', () => store.selectedElement(), []);
  const mode = useValue('ws.mode', () => store.mode, []);
  const descend = useValue('ws.descend', () => store.panel.descend, []);
  const catalogAdd = useValue('ws.catalogAdd', () => store.panel.catalogAdd, []);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const project = projects.find((p) => p.id === projectId) ?? null;

  // The quiet words: one line under the canvas, a refusal at a point; each fades on its own.
  const [quietLine, setQuietLine] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ at: Placed; sentence: string } | null>(null);
  const timers = useRef<{ q?: number; r?: number }>({});
  const quiet = (sentence: string): void => { setQuietLine(sentence); window.clearTimeout(timers.current.q); timers.current.q = window.setTimeout(() => setQuietLine(null), 4000); };
  const speakRefusal = (at: Placed, sentence: string): void => { setRefusal({ at, sentence }); window.clearTimeout(timers.current.r); timers.current.r = window.setTimeout(() => setRefusal(null), 3000); };
  useEffect(() => () => { window.clearTimeout(timers.current.q); window.clearTimeout(timers.current.r); }, []);

  const [entered, setEntered] = useState<{ kind: 'grid'; dataset: string } | { kind: 'notes'; projectId: string } | null>(null);
  const [configCard, setConfigCard] = useState<ConfigCardState | null>(null);
  const [menu, setMenu] = useState<WorkspaceMenuState | null>(null);
  const [picker, setPicker] = useState<LanePicker | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteConfirm | null>(null);
  const [ask, setAsk] = useState<{ rect: { x: number; y: number; w: number; h: number }; client: Placed; frame: { screenId: string; scene: string; rel: { x: number; y: number; w: number; h: number } } | null } | null>(null);
  const placeAt = useRef<Placed | null>(null);
  const cardOn = (nodeId: string): void => { const n = byId.get(nodeId); setConfigCard({ mode: 'node', client: null, sel: n !== undefined ? citizenSel(n) : { citizen: true, kind: 'step', nodeId, label: nodeId, projectId } }); };
  const newTrigger = (prefill?: { dataset?: string; operation?: string }): void => setConfigCard({ mode: 'trigger-new', ...(prefill !== undefined ? { prefill } : {}), client: null });

  const integrationRows = usePlaceableIntegrations(orgId, { projectKind: project?.kind ?? null });
  const stepRows = usePlaceableSteps();
  const doorRows = usePlaceableDoors(orgId, { projectKind: project?.kind ?? null });
  const triggerRows = usePlaceableTriggers(orgId, { projectKind: project?.kind ?? null });
  const badges = useValue('ws.badges', () => store.badges.get(), []);
  const replayActive = useValue('ws.replay', () => store.replayActive.get(), []);
  const sentence = useValue('ws.sentence', () => store.editing.sentence, []);

  // The wire lane's deps: the history is the mounted editor's, read at call time.
  const lane: WireLaneDeps = {
    orgId, projectId, quiet, speakRefusal,
    get history() { return activeEditor.get()!.history; },
    openPicker: setPicker, openTriggerCard: newTrigger, openConfig: cardOn,
    placeStep: (kind, at, params, quietCard) => placeStep(kind, at, params, quietCard),
  };

  // ---- the add lane: births through the kernel's doors; the born card lands at the remembered spot ----
  function placeBorn(nodeId: string | null): void {
    if (nodeId === null || placeAt.current === null) return;
    store.placeNodes({ [nodeId]: placeAt.current }, 'user');
    placeAt.current = null;
  }
  async function connectionFor(service: string): Promise<{ id: string; label: string; projectId: string | null; insideTables: Record<string, string> } | null> {
    if (projectId === null) { quiet('open a project to place a connection'); return null; }
    const have = (await desk.integrationsList(orgId, projectId).catch(() => [])).find((c) => c.integration === service && c.status !== 'revoked');
    if (have !== undefined) return have;
    const born = await desk.integrationsPlace(orgId, { projectId, name: service });
    const inner = born.ok ? born.data : undefined;
    if (inner === undefined || inner.ok !== true) { quiet((born.ok ? (inner !== undefined && !inner.ok ? inner.refusal : undefined) : born.error) ?? 'the connection could not be placed'); return null; }
    store.bornNode({ id: `intg:${inner.connection.id}`, kind: 'integration', label: inner.connection.label, detail: 'not connected yet', lastActivityAt: null, projectId: inner.connection.projectId });
    return inner.connection;
  }
  async function placeIntegration(name: string, at?: Placed): Promise<void> {
    placeAt.current = at ?? null;
    const conn = await connectionFor(name);
    if (conn === null) return;
    placeBorn(`intg:${conn.id}`); cardOn(`intg:${conn.id}`);
  }
  async function placeStep(kind: string, at?: Placed, params?: Record<string, unknown>, quietCard?: boolean): Promise<string | null> {
    if (projectId === null) { quiet('open a project to place a step'); return null; }
    placeAt.current = at ?? null;
    const res = await desk.flowsPlaceStep(orgId, projectId, kind, params);
    if (!res.ok || res.data === undefined) { quiet(!res.ok ? res.error : 'the step could not be placed'); return null; }
    const def = (await desk.flowStepCatalog().catch(() => [])).find((d) => d.kind === kind);
    const id = `fstep:${res.data.flowId}:${res.data.stepId}`;
    if (params?.['fused'] !== true) {
      store.bornNode({ id, kind: 'step', label: def?.displayName ?? kind, detail: def?.blurb ?? null, lastActivityAt: null, projectId });
      placeBorn(id);
      if (quietCard !== true) cardOn(id);
    }
    return id;
  }
  async function placeDoorStep(service: string, endpoint: string, at?: Placed): Promise<void> {
    if (projectId === null) { quiet('open a project to place a door'); return; }
    placeAt.current = at ?? null;
    const conn = await connectionFor(service);
    if (conn === null) return;
    const res = await desk.flowsPlaceStep(orgId, projectId, 'call-integration', { connection: conn.id, endpoint });
    if (!res.ok || res.data === undefined) { quiet(!res.ok ? res.error : 'the door could not be placed'); return; }
    const def = (await desk.integrationsCatalog().catch(() => [])).find((d) => d.name === service);
    const id = `fstep:${res.data.flowId}:${res.data.stepId}`;
    store.bornNode({ id, kind: 'step', label: def?.endpoints.find((e) => e.id === endpoint)?.displayName ?? endpoint, detail: def?.displayName ?? service, lastActivityAt: null, projectId }, [{ from: id, to: `intg:${conn.id}`, verb: 'runs' }]);
    placeBorn(id); cardOn(id);
  }
  async function placeTriggerRow(service: string, trigger: string, at?: Placed): Promise<void> {
    if (projectId === null) { quiet('open a project to place a trigger'); return; }
    placeAt.current = at ?? null;
    const def = (await desk.integrationsCatalog().catch(() => [])).find((d) => d.name === service);
    const row = def?.triggers.find((t) => t.id === trigger);
    if (def === undefined || row === undefined) { quiet('that trigger is not on the shelf any more'); return; }
    const main = (await desk.flowsList(orgId, projectId).catch(() => [])).find((f) => f.name === 'main');
    const doc = (main?.doc ?? null) as { steps?: Record<string, { kind?: string }>; edges?: Array<{ to: string }> } | null;
    const targets = new Set((doc?.edges ?? []).map((e) => e.to));
    const roots = Object.keys(doc?.steps ?? {}).filter((id) => !targets.has(id));
    if (main === undefined || roots.length === 0) { quiet('place a step first - this watcher starts your flow at it'); return; }
    const pid = projectId;
    const land = async (entry: string): Promise<void> => {
      const conn = await connectionFor(service);
      if (conn === null) return;
      let kind: string; let spec: Record<string, unknown>; let dataset: string | undefined;
      if (row.kind === 'poll') {
        dataset = conn.insideTables[row.table];
        if (dataset === undefined) { quiet('that connection has no inner table to watch'); return; }
        kind = 'rows_changed'; spec = { dataset };
      } else {
        const scheme = def.webhookScheme;
        if (scheme === null) { quiet(`${def.displayName} webhooks cannot be verified yet`); return; }
        let token = (await desk.integrationsWebhooksList(orgId, pid).catch(() => [])).find((e) => e.scheme === scheme)?.token ?? null;
        if (token === null) {
          const minted = await desk.integrationsWebhooksCreate(orgId, { projectId: pid, label: `${def.displayName} events`, scheme });
          const inner = minted.ok ? minted.data : undefined;
          if (inner === undefined || inner.ok !== true) { quiet((minted.ok ? (inner !== undefined && !inner.ok ? inner.refusal : undefined) : minted.error) ?? 'the webhook address could not be minted'); return; }
          token = inner.endpoint.token;
        }
        kind = 'webhook_in'; spec = { endpoint: token, event: { path: row.eventPath, oneOf: row.events } };
      }
      const res = await desk.humanMintTrigger(orgId, kind, spec, { type: 'start_flow', flow: 'main', entry }, pid);
      if (!res.ok || res.data === undefined) { quiet(!res.ok ? res.error : 'the watcher could not be minted'); return; }
      const tid = watcherMinted(lane, { triggerId: res.data.triggerId, kind, ...(dataset !== undefined ? { dataset } : {}), connectionId: conn.id, flowStep: `fstep:${main.id}:${entry}` }, pid);
      placeBorn(tid); cardOn(tid);
    };
    if (roots.length === 1) { await land(roots[0]!); return; }
    const stepCatalog = await desk.flowStepCatalog().catch(() => []);
    const seen = new Map<string, number>();
    const doors = roots.map((id) => { const base = stepCatalog.find((d) => d.kind === doc?.steps?.[id]?.kind)?.displayName ?? 'Step'; const nth = (seen.get(base) ?? 0) + 1; seen.set(base, nth); return { id, word: nth === 1 ? base : `${base} ${nth}`, klass: 'read' as const }; });
    if (!store.openBrowser({ mode: 'wire', headline: 'Start the flow at which step?', doors, projectId: pid, onPick: (choice) => { if (choice.pick === 'door') void land(choice.id); } })) quiet('open the side panel to pick the starting step');
  }
  async function seedComponentScene(ref: string): Promise<string | null> {
    const base = ref.split('::')[1]?.split('@')[0] ?? ref.split('@')[0] ?? 'view';
    const r = await desk.humanInsertScene(orgId, base, defaultSceneSize(project?.kind), projectId ?? undefined);
    if (!r.ok || r.data === undefined) { if (!r.ok) quiet(r.error); return null; }
    const seeded = await desk.sceneApplyOps(orgId, r.data.slug, [{ op: 'create_node', id: 'seed', parent: 'root', position: { anchor: 'end' }, components: { [primitiveRef('instance')]: { component: ref } } }]);
    if (seeded.ok && seeded.data && !seeded.data.ok) quiet(seeded.data.errors.join(' - '));
    return `scene:${r.data.sceneId}`;
  }
  /** A named birth (Table, Screen, Tool): the browser's create row asked the words; the kernel door lands it. */
  async function insertNamed(kind: AddKind, name: string, typed?: string, wireFrom?: NodeRecord): Promise<void> {
    const word = typed !== undefined && typed !== '' && typed !== name ? typed : undefined;
    let born: string | null = null;
    if (kind === 'tool') {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!draftNameValid(slug)) { quiet('a tool name is plain words - letters and numbers'); return; }
      const d = freshDraft(slug);
      const r = await desk.registerOperationVersion(orgId, d.name, d.code, { runtime: d.runtime, ioContract: d.ioContract, ...(word !== undefined ? { displayName: word } : {}) }, projectId ?? undefined);
      if (!r.ok) { quiet(r.error); return; }
      store.bornNode({ id: `op:${slug}`, kind: 'operation', label: slug, ...(word !== undefined ? { word } : {}), detail: null, lastActivityAt: null, projectId });
      born = `op:${slug}`;
    } else if (kind === 'table') {
      const r = await desk.humanInsertDataset(orgId, name, undefined, projectId ?? undefined, word);
      if (!r.ok) { quiet(r.error); return; }
      store.bornNode({ id: `ds:${name}`, kind: 'dataset', label: name, ...(word !== undefined ? { word } : {}), detail: null, lastActivityAt: null, projectId });
      born = `ds:${name}`;
    } else {
      const r = await desk.humanInsertScene(orgId, name, defaultSceneSize(project?.kind), projectId ?? undefined);
      if (!r.ok || r.data === undefined) { if (!r.ok) quiet(r.error); return; }
      store.bornNode({ id: `scene:${r.data.sceneId}`, kind: 'scene', label: name, detail: null, lastActivityAt: null, projectId });
      born = `scene:${r.data.sceneId}`;
      if (wireFrom !== undefined && wireFrom.id.startsWith('ds:')) await landDataWire(lane, r.data.slug, wireFrom.label, {});
    }
    placeBorn(born);
    if (born !== null && wireFrom !== undefined && kind !== 'view') { const target = store.node(born); if (target !== undefined) void wireDrop(lane, wireFrom, target, placeAt.current ?? { x: 120, y: 120 }); }
  }
  /** The create palette's births: the named kinds ask their words in the browser's create row; the rest open their own door. */
  function addCitizen(kind: AddKind, at?: Placed, wireFrom?: NodeRecord): void {
    placeAt.current = at ?? null;
    if (NAMED_INSERTS.has(kind)) {
      const opened = store.openBrowser({
        mode: 'wire', headline: `Name the new ${kind === 'view' ? (project?.kind === 'website' ? 'website page' : 'screen') : kind}`, naming: kind, projectId,
        onPick: (c) => { if (c.pick === 'insert' && c.name !== undefined) void insertNamed(c.kind, c.name, c.typed, wireFrom); },
      });
      if (!opened) quiet('open the side panel to name it');
    } else if (kind === 'watcher') newTrigger();
    else if (projectId !== null) setEntered({ kind: 'notes', projectId });
  }
  function handleCatalogAdd(add: CatalogAdd): void {
    if ('item' in add) void seedComponentScene(add.item).then(placeBorn);
    else if ('primitive' in add) store.setMode({ picked: 'create', armed: armOf(add.primitive) });
    else if ('integration' in add) void placeIntegration(add.integration);
    else if ('step' in add) void placeStep(add.step);
    else if ('door' in add) void placeDoorStep(add.door.service, add.door.endpoint);
    else if ('trigger' in add) void placeTriggerRow(add.trigger.service, add.trigger.id);
    else if (add.name !== undefined) void insertNamed(add.kind, add.name, add.typed);
    else addCitizen(add.kind);
  }
  const addRef = useRef(handleCatalogAdd); addRef.current = handleCatalogAdd;
  useEffect(() => { if (catalogAdd !== null) addRef.current(catalogAdd.add); }, [catalogAdd]);
  useEffect(() => { if (descend !== null) setEntered(descend.target); }, [descend]);

  // The create pick: Screen + the five placeable primitives - a bare instance reads "New instance" until its component is picked in properties.
  const armOf = (name: PrimitiveName): CreateArm => ({ kind: 'primitive', label: PRIMITIVES[name].title, name, prefill: {} });
  const pickRows = (act: (arm: CreateArm) => void): MenuGroups => [
    [{ key: 'screen', label: 'Screen', icon: kindIcon('scene'), onAct: () => act({ kind: 'screen', label: 'Screen' }) }],
    (['frame', 'text', 'field', 'chart', 'instance'] as const).map((n) => ({ key: n, label: PRIMITIVES[n].title, icon: Shapes, onAct: () => act(armOf(n)) })),
  ];
  const createDeps = { orgId, projectId, projectKind: project?.kind ?? null, quiet, placeAt, placeBorn };

  // The browser question: the pick rides the context back here.
  function handlePick(choice: NodeBrowserPick, ctx: NodeBrowseContext): void {
    const source = ctx.source !== undefined ? byId.get(ctx.source.id) : undefined;
    if (choice.pick === 'node') {
      const target = byId.get(choice.id);
      if (source !== undefined && target !== undefined) void wireDrop(lane, source, target, { x: 120, y: 120 });
      else if (target !== undefined) store.openInspector(citizenSel(target));
    } else if (choice.pick === 'insert') {
      if (choice.name !== undefined) void insertNamed(choice.kind, choice.name, choice.typed, source);
      else if (choice.kind === 'tool' && source === undefined) navigate(projectId !== null ? `/code/${projectId}?draft=1` : '/code?draft=1');
      else addCitizen(choice.kind, undefined, source);
    }
  }
  const pickRef = useRef(handlePick); pickRef.current = handlePick;
  const browse = (context: Omit<NodeBrowseContext, 'mode' | 'onPick' | 'projectId'>): void => {
    if (!store.openBrowser({ ...context, mode: 'wire', projectId, onPick: (c, x) => pickRef.current(c, x) })) quiet('the node browser has no panel to open in');
  };

  function deleteIds(ids: ReadonlySet<string>): void {
    const gone = [...ids].filter((id) => deletableOnMap(id) && !id.startsWith('ds:'));
    if (gone.length > 0) store.markGone(gone);
    void deleteMapSelection({ orgId, projectId, sceneSlugOf: (id) => store.sceneSlugOf(id) }, ids, byId).then((c) => { if (c !== null) setConfirmDelete(c); });
    store.clearSelection();
  }
  const foldDoorFor = (id: string, sel: ReadonlySet<string>): { verb: 'fold' | 'unfold'; act: () => void } | null => {
    const editor = activeEditor.get();
    if (editor === null) return null;
    if (id.startsWith('fold:')) return { verb: 'unfold', act: () => dissolveFold(editor, id) };
    const members = expandFoldSelection(editor, [...(sel.has(id) ? sel : new Set([id]))]);
    const verdict = canFold(members);
    if (!verdict.ok || members.length < 2) return null;
    return { verb: 'fold', act: () => { const g = mintGroup(members); store.setFolds([...store.arrangement.folds, g], 'user'); store.selectCards([g.id]); } };
  };

  const doors: Doors = {
    quiet, speakRefusal,
    wireEmpty: (from) => browse({ headline: 'What happens next?', source: { id: from.id, kind: from.kind, label: from.label } }),
    nodeOpen: (n) => {
      if (n.id.startsWith('fold:')) { const editor = activeEditor.get(); if (editor !== null) dissolveFold(editor, n.id); return; }
      const t = descentFor(n.kind, n.projectId);
      if (t.open === 'notes') setEntered({ kind: 'notes', projectId: t.projectId });
      else if (t.open === 'rows') setEntered({ kind: 'grid', dataset: n.label });
      else if (t.open === 'zoom') { store.selectCards([n.id]); const screen = store.screenOf(n.id); if (screen !== undefined) store.requestScreenFocus(screen.sceneId); }
    },
    nodeContext: (n, client) => { const sel = selected.has(n.id) ? selected : new Set([n.id]); store.selectCards(sel); setMenu({ kind: 'node', client, nodeId: n.id, sel }); },
    canvasContext: (at, client) => setMenu({ kind: 'create', client, canvasAt: at }),
    elementContext: (scene, screenId, point, client) => { const frame = activeEditor.get()?.frameOf(screenId); const id = frame?.hitTest(client) ?? null; if (id !== null) { store.selectElement(scene, screenId, id); const s = store.screenOf(screenId); if (s !== undefined) store.openInspector({ sceneId: s.sceneId, sceneSlug: scene, sceneTitle: s.title, nodeId: id }); } void point; },
    deleteNodes: deleteIds,
    createLand: (g) => { const editor = activeEditor.get(); const armed = store.mode.armed; if (editor !== null && armed !== null) void landCreate(editor, createDeps, armed, g); else setAsk(g); },
    elementWireOut: (source, target) => { const el = store.element(source.scene, source.id); if (el !== undefined) void elementWireOut({ orgId, projectId, scene: source.scene, history: lane.history, say: quiet, placeStep: lane.placeStep }, el, source.cls, target); },
    channelDrop: (scene, fromEl, emit, emitType, toEl) => void channelDrop({ orgId, history: lane.history, say: quiet }, scene, fromEl, emit, emitType, toEl),
    dropOnElement: async (source, scene, _screenId, elementId) => { const el = store.element(scene, elementId); if (el === undefined) return false; return attachElement({ orgId, projectId, scene, history: lane.history, say: quiet, placeStep: lane.placeStep }, el, elementClassOfNode(el.node), { kind: source.kind, label: source.label, id: source.id }); },
    wireDrop: (from, to, at, port) => void wireDrop(lane, from, to, at, port),
    lane,
  };

  const decor: EngineDecor = {
    decorate: (n) => { const badge = badges.get(n.id); const d: CanvasNode = badge !== undefined ? { ...n, badge } : { ...n }; return n.id.startsWith('fstep:') && badge !== undefined ? { ...d, growExtra: store.lastRunWordFor(n.id) ?? null, onBadge: () => store.startReplay(n.id) } : d; },
    nodeFold: (n) => foldDoorFor(n.id, selected),
    nodeExtras: (n) => { const slug = store.sceneSlugOf(n.id); return slug === null ? [] : [{ key: 'play', icon: Play, label: 'Play - open the app full screen', onAct: () => { if (!store.openFocusedScene(slug)) quiet('the app surface is not ready'); } }]; },
    nodeProps: (n) => { const full = byId.get(n.id); return full === undefined ? undefined : () => store.openInspector(citizenSel(full)); },
    outPortsFor: (id) => store.outPortsFor(id),
    onNodeVerb: (n, door) => { const full = byId.get(n.id); if (full !== undefined) void openVerbDoor({ orgId, say: quiet }, citizenSel(full), door); },
    onPortPlus: (n) => browse({ headline: 'What happens next?', source: { id: n.id, kind: n.kind, label: n.label } }),
    selectionSentence: sentence,
    activeIds: replayActive === null ? new Set() : new Set([replayActive.node]),
    edgeDoors: (e) => { const remove = edgeRemover(orgId, e, byId, quiet); const word = store.countWordFor(e); return { ...(remove !== undefined ? { onRemove: remove } : {}), ...(word !== undefined ? { countWord: word } : {}), onSplice: () => { const a = byId.get(e.from); const b = byId.get(e.to); if (a !== undefined && b !== undefined) browse({ headline: `Between ${a.label} and ${b.label}`, between: { fromKind: a.kind, toKind: b.kind, fromLabel: a.label, toLabel: b.label } }); } }; },
    replay: replayActive,
  };
  // A selected wire opens its sentence in the inspector; a single card re-aims an open contract form.
  useEffect(() => { if (wireSel !== null) { const e = edges.find((x) => x.from === wireSel.from && x.to === wireSel.to && x.action === wireSel.action && x.rule === wireSel.rule && x.param === wireSel.param && x.port === wireSel.port && x.slot === wireSel.slot); const subject = e !== undefined ? wireSubject(e, byId, projectId) : null; if (subject !== null) store.openInspector(subject); } }, [wireSel]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selected.size === 1) { const n = byId.get([...selected][0]!); if (n !== undefined) store.retargetInspector(citizenSel(n)); } }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // A selected element re-aims the open inspector at its properties (selection opens properties).
  useEffect(() => { if (elementSel !== null && elementSel.elementId !== 'root') { const s = store.screenOf(elementSel.screenId); if (s !== undefined) store.retargetInspector({ sceneId: s.sceneId, sceneSlug: elementSel.scene, sceneTitle: s.title, nodeId: elementSel.elementId, extraIds: [...elementSel.extras] }); } }, [elementSel]); // eslint-disable-line react-hooks/exhaustive-deps

  if (entered !== null) {
    const onRowEdit: ComponentProps<typeof WorkspaceEntered>['onRowEdit'] = () => undefined;
    return <WorkspaceEntered title={cluster.title} entered={entered} quietLine={quietLine} onExit={() => setEntered(null)} onRowEdit={onRowEdit} />;
  }
  const menuNode = (n: { id: string }): NodeRecord | undefined => byId.get(n.id);
  return (
    <div className={canvasStyles.wrap}>
      <div className={styles.benchBar}><span className={`${canvasStyles.crumb} ${canvasStyles.crumbStill}`}>{cluster.title}</span></div>
      <DropTarget onQuiet={quiet} projectId={projectId ?? undefined} projectName={project?.name} onComponentDrop={(ref, at) => { placeAt.current = at; void seedComponentScene(ref).then(placeBorn); }}>
        <CanvasEngine doors={doors} decor={decor} camResetKey={`bench:${orgId}:${projectId ?? ''}`}>
          {refusal !== null ? <DropRefusal at={refusal.at} sentence={refusal.sentence} /> : null}
        </CanvasEngine>
      </DropTarget>
      <ModeToolbar
        pickRows={pickRows} mode={mode.picked} onMode={(m) => store.setMode({ picked: m, ...(m !== 'create' ? { armed: null } : {}) })}
        armed={mode.armed}
        ask={ask} onAskPick={(arm) => { const g = ask; setAsk(null); const editor = activeEditor.get(); if (g !== null && editor !== null) void landCreate(editor, createDeps, arm, g); }} onAskClose={() => setAsk(null)}
      />
      {quietLine !== null ? <div className={styles.benchQuietFloat}>{quietLine}</div> : null}
      {projectId !== null && nodes.length === 0 ? <div className={canvasStyles.emptyTeach}>right-click to create - drag from a port to connect</div> : null}
      <CornerLegend storageKey={`obs-legend:${orgId}`} lines={['V - C - H: select - create - hand', 'right-click: create', 'drag from a port: connect', 'double-click: open', 'Shift+1/2/0: fit - selection - 100%']} />
      <WorkspaceOverlays
        confirmDelete={confirmDelete}
        onConfirmDelete={(name) => { setConfirmDelete(null); store.markGone([`ds:${name}`]); void desk.humanDeleteDataset(orgId, name, projectId ?? undefined); }}
        onDismissConfirm={() => setConfirmDelete(null)}
        menu={menu} onMenuClose={() => setMenu(null)}
        menuDeps={{
          viewWord: project?.kind === 'website' ? 'Website' : 'App', byId, foldDoorFor,
          addCitizen: (kind, at) => addCitizen(kind, at),
          integrations: integrationRows, placeIntegration: (name, at) => void placeIntegration(name, at),
          steps: stepRows, placeStep: (kind, at) => void placeStep(kind, at),
          doors: doorRows, placeDoor: (service, endpoint, at) => void placeDoorStep(service, endpoint, at),
          triggers: triggerRows, placeTrigger: (service, trigger, at) => void placeTriggerRow(service, trigger, at),
          openVerb: (n, door) => { const full = menuNode(n); if (full !== undefined) void openVerbDoor({ orgId, say: quiet }, citizenSel(full), door); },
          openProps: (n) => { const full = menuNode(n); if (full !== undefined) store.openInspector(citizenSel(full)); },
          connect: (n) => browse({ headline: 'What happens next?', source: { id: n.id, kind: n.kind, label: n.label } }),
          deleteIds,
        }}
        picker={picker}
        onPicked={(p) => { const req = picker; setPicker(null); if (req !== null) void pickerLanded(lane, req, p, (slug, dataset, payload) => landDataWire(lane, slug, dataset, payload)); }}
        onPickerClose={() => setPicker(null)}
      />
      {configCard !== null ? (
        <NodeConfigCard
          orgId={orgId} projectId={projectId} card={configCard} say={quiet} onClose={() => setConfigCard(null)}
          datasets={nodes.filter((n) => n.id.startsWith('ds:')).map((n) => n.label)}
          operations={[...new Set(nodes.filter((n) => n.id.startsWith('op:')).map((n) => n.label.replace(/@\d+$/, '')))]}
          onVerb={(door) => { const s = configCard.mode === 'node' ? configCard.sel : null; if (s !== null) void openVerbDoor({ orgId, say: quiet }, s, door); }}
          onTriggerMinted={(minted) => { placeBorn(watcherMinted(lane, minted, projectId)); }}
          onTriggerReminted={(minted, oldId) => { const from = store.positionOf(`trg:${oldId}`); store.markGone([`trg:${oldId}`]); const tid = watcherMinted(lane, minted, projectId); if (from !== undefined) store.placeNodes({ [tid]: from }, 'user'); }}
        />
      ) : null}
    </div>
  );
}
