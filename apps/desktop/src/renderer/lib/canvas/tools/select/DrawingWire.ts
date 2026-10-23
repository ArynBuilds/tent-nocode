import { checkWire, datasetGrantPatterns, elementPortRule, keyBetween, legalTargets, primitiveOfNode, primitiveRef, triggerKindWord } from '@tent-nocode/core';
import type { ElementClass, WireEnd } from '@tent-nocode/core';
import { desk } from '../../../desk.js';
import { StateNode, type Editor, type PointerInfo } from '../StateNode.js';
import { store, type ElementRecord, type NodeRecord, type Placed } from '../../store.js';
import type { History } from '../../history.js';
import { NO_DOORS_SENTENCE, pickColumn, pickConnectionDoor, resolveConnectionDoors } from '../../../page-edit/endpointPick.js';
import { buttonWordOf, declareAction, rowNavNode } from '../../../page-edit/actionWires.js';
import { flowLinkNode, freshId } from '../../../page-edit/flowWires.js';
import type { PickerPayload, PickerRequest } from '../../../../components/page-edit/ExpressionPicker.js';

// SELECT / DRAWING WIRE: wires are a tool. A drag from a citizen's out port, an element's port inside a
// focused screen, or an emit port draws the line; the drop lands on the contract's verdict (checkWire for
// citizens, the element-port law for elements) through the kernel's doors - the picker asks the questions,
// a refusal speaks at the drop point, a landed declaration's edge renders at once, a minted row's undo is
// its own door. Empty space opens the node browser with the question.

export interface LaneNode { id: string; kind: string; label: string; projectId: string | null }
export type LanePicker = PickerRequest & { source: LaneNode; target: LaneNode };

/** What the wire lane needs from the mount beyond the store: the picker, the trigger card, the step placement. */
export interface WireLaneDeps {
  orgId: string;
  projectId: string | null;
  history: History;
  quiet: (sentence: string) => void;
  speakRefusal: (at: Placed, sentence: string) => void;
  openPicker: (request: LanePicker) => void;
  openTriggerCard: (prefill: { dataset?: string; operation?: string }) => void;
  openConfig: (nodeId: string) => void;
  placeStep: (kind: string, at: Placed | undefined, params: Record<string, unknown>, quietCard: boolean) => Promise<string | null>;
}

export class DrawingWire extends StateNode {
  static override id = 'drawingWire';

  private source: PointerInfo['target'] | null = null;
  private anchor: Placed = { x: 0, y: 0 };

  override onEnter(info: PointerInfo): void {
    const { store: s } = this.editor;
    const t = info.target;
    this.source = t;
    if (t.kind === 'port') {
      const r = s.rectOf(t.id);
      this.anchor = r !== undefined ? { x: r.x + r.w, y: r.y + r.h / 2 } : info.world;
      s.setGesture({ wire: { fromId: t.id, from: this.anchor, to: this.anchor }, cursor: 'crosshair' });
    } else if (t.kind === 'element-port' || t.kind === 'emit-port') {
      const w = this.editor.elementWorldRect(t.screenId, t.id);
      this.anchor = w !== null ? { x: w.x + w.w, y: w.y + w.h / 2 } : info.world;
      s.setGesture({ wire: { fromId: t.screenId, from: this.anchor, to: this.anchor, element: { scene: t.scene, id: t.id, cls: t.kind === 'element-port' ? t.cls : 'display' } }, cursor: 'crosshair' });
    } else { this.parent.transition('idle'); return; }
  }

  override onExit(): void {
    this.editor.store.setGesture({ wire: null, cursor: null });
    this.source = null;
  }

  override onPointerMove(info: PointerInfo): void {
    const g = this.editor.store.gesture.wire;
    if (g !== null) this.editor.store.setGesture({ wire: { ...g, to: info.world } });
  }

  override onPointerUp(info: PointerInfo): void {
    const { store: s, doors } = this.editor;
    const src = this.source;
    this.parent.transition('idle');
    if (src === null) return;
    const far = Math.hypot(info.world.x - this.anchor.x, info.world.y - this.anchor.y) > 24;
    if (src.kind === 'port') {
      const source = s.node(src.id);
      if (source === undefined) return;
      const hit = s.innermostAt(info.world, src.id);
      const target = hit !== null ? s.node(hit.id) : undefined;
      if (hit !== null && target !== undefined) {
        // A drop on an element inside a screen wires the element first; else the citizen.
        const screen = s.screenOf(hit.id);
        if (screen !== undefined) {
          const frame = this.editor.frameOf(hit.id);
          const el = frame?.hitTest(info.client) ?? null;
          if (el !== null && el !== 'root') { void doors.dropOnElement(source, screen.slug, hit.id, el).then((took) => { if (!took) doors.wireDrop(source, target, info.world, src.port); }); return; }
        }
        doors.wireDrop(source, target, info.world, src.port);
        return;
      }
      if (hit !== null && hit.id.startsWith('fold:')) { doors.speakRefusal(info.world, 'unfold the group to wire the things inside'); return; }
      if (far) doors.wireEmpty(source, info.world);
      return;
    }
    if (src.kind === 'element-port') {
      const hit = s.innermostAt(info.world, src.screenId);
      const target = hit !== null ? s.node(hit.id) : undefined;
      if (hit !== null && hit.id.startsWith('fold:')) { doors.quiet('unfold the group to wire the things inside'); return; }
      if (target !== undefined) { doors.elementWireOut({ scene: src.scene, screenId: src.screenId, id: src.id, cls: src.cls }, target, info.client); return; }
      if (far) doors.elementWireOut({ scene: src.scene, screenId: src.screenId, id: src.id, cls: src.cls }, null, info.client);
      return;
    }
    if (src.kind === 'emit-port') {
      const frame = this.editor.frameOf(src.screenId);
      const el = frame?.hitTest(info.client) ?? null;
      doors.channelDrop(src.scene, src.id, src.emit, src.emitType, el !== null && el !== 'root' && el !== src.id ? el : null);
    }
  }

  override onCancel(): void { this.parent.transition('idle'); }
  override onComplete(): void { this.parent.transition('idle'); }
}

// ---------------------------------------------------------------------------
// The citizen wire lane: the contract's verdict routes the drop.
// ---------------------------------------------------------------------------

export const opName = (label: string): string => label.replace(/@\d+$/, '');

/** The first slot of the wanted type takes the wired name. */
export function inputsFor(end: WireEnd, value: string): Record<string, unknown> {
  const entries = Object.entries(end.contract?.inputs ?? {});
  const slot = entries.find(([, d]) => d.type === 'dataset' || d.type === 'array' || d.type === 'raster');
  return slot ? { [slot[0]]: value } : {};
}

const toLane = (n: NodeRecord): LaneNode => ({ id: n.id, kind: n.kind, label: n.label, projectId: n.projectId });

export async function wireDrop(deps: WireLaneDeps, sourceNode: NodeRecord, targetNode: NodeRecord, at: Placed, port?: string): Promise<void> {
  const source = toLane(sourceNode);
  const target = toLane(targetNode);
  const a: WireEnd = { kind: source.kind as WireEnd['kind'], label: source.label };
  const b: WireEnd = { kind: target.kind as WireEnd['kind'], label: target.label };
  if (b.kind === 'operation') { const c = await desk.operationContract(deps.orgId, opName(target.label)); if (c) b.contract = c; }
  if (a.kind === 'operation') { const c = await desk.operationContract(deps.orgId, opName(source.label)); if (c) a.contract = c; }
  const verdict = checkWire(a, b);
  if (!verdict.ok) { deps.speakRefusal(at, verdict.sentence); return; }
  const screensOf = (t: LaneNode): Array<{ slug: string; title: string }> => store.screens.get().filter((s) => (store.node(s.nodeId)?.projectId ?? null) === t.projectId).map((s) => ({ slug: s.slug, title: s.title }));
  switch (verdict.compile.write) {
    case 'binding': {
      const preferred = store.sceneSlugOf(target.id) ?? undefined;
      deps.openPicker({ mode: 'binding', dataset: source.label, targetLabel: target.label, verb: verdict.compile.sentence, source, target, screens: screensOf(target), ...(preferred !== undefined ? { preferredScreen: preferred } : {}) });
      return;
    }
    case 'op-input':
      deps.openPicker({ mode: 'op-run', dataset: source.label, targetLabel: target.label, verb: verdict.compile.sentence, source, target, canChain: Object.values(b.contract?.inputs ?? {}).some((d) => d.type === 'array' || d.type === 'raster') });
      return;
    case 'chain': {
      const res = await desk.humanMintChain(deps.orgId, opName(target.label), inputsFor(b, source.label), deps.projectId ?? undefined);
      if (!res.ok) { deps.speakRefusal(at, res.error); return; }
      if (res.data) { echoChain(deps, res.data.chainId, source, target); }
      return;
    }
    case 'trigger-source':
      deps.openTriggerCard(source.id.startsWith('ds:') ? { dataset: source.label } : {});
      return;
    case 'trigger-action':
      if (a.kind === 'trigger' && target.id.startsWith('intg:')) { await retargetWatcherToIntegration(deps, source, target, at); return; }
      if (a.kind === 'trigger') deps.openTriggerCard({ operation: opName(target.label) });
      else deps.openPicker({ mode: 'app-action', targetLabel: target.label, verb: verdict.compile.sentence, source, target });
      return;
    case 'grant':
      await writeGrant(deps, source, target, at);
      return;
    case 'write-back':
      deps.openPicker({ mode: 'write-back', dataset: target.label, targetLabel: target.label, verb: verdict.compile.sentence, output: verdict.compile.output, source, target });
      return;
    case 'nav':
      await wireScreens(deps, source, target, at);
      return;
    case 'result-binding':
      await bindOutputToScene(deps, source, target, at);
      return;
    case 'step-wire': {
      const [, sFlow, sStep] = source.id.split(':');
      const [, tFlow, tStep] = target.id.split(':');
      if (sFlow === undefined || sStep === undefined || sFlow !== tFlow || tStep === undefined) { deps.speakRefusal(at, 'these steps live in different flows'); return; }
      const res = await desk.flowsWireSteps(deps.orgId, sFlow, sStep, tStep, port !== undefined ? { port } : undefined);
      if (!res.ok || res.data === undefined) { deps.speakRefusal(at, !res.ok ? res.error : 'the wire would not land'); return; }
      store.bornEdge({ from: source.id, to: target.id, verb: 'feeds', port: res.data.port, slot: res.data.slot });
      deps.openConfig(target.id);
      return;
    }
    case 'trigger-start-flow': await retargetTriggerToStep(deps, source, target, at); return;
    case 'table-to-step': await landTableOnStep(deps, source, target, at); return;
    case 'step-to-tool': await landFusedToolWire(deps, source, target, at, 'step-to-tool'); return;
    case 'tool-to-step': await landFusedToolWire(deps, source, target, at, 'tool-to-step'); return;
  }
}

function echoChain(deps: WireLaneDeps, chainId: string, source: LaneNode, target: LaneNode): void {
  const id = `chain:${chainId}`;
  store.bornNode({ id, kind: 'chain', label: `re-runs ${opName(target.label)}`, detail: null, lastActivityAt: null, projectId: deps.projectId }, [
    { from: source.id, to: id, verb: 'updates' }, { from: id, to: target.id, verb: 'runs' },
  ]);
  deps.history.pushDoor('keep updated', async () => { await desk.revokeReactiveChain(deps.orgId, chainId); store.markGone([id]); return { ok: true }; });
}

/** The scope wire: reach-shaped standing answers through the impact doors; the dotted wire renders now. */
async function writeGrant(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed): Promise<void> {
  const agents = await desk.listAgents(deps.orgId);
  const agent = agents.find((x) => x.slug === source.label);
  if (agent === undefined) { deps.speakRefusal(at, `${source.label} has no standing identity yet`); return; }
  for (const p of datasetGrantPatterns(target.label)) {
    const res = await desk.grantImpact(deps.orgId, agent.id, p);
    if (!res.ok) { deps.speakRefusal(at, res.error); return; }
  }
  const revert = store.bornEdge({ from: source.id, to: target.id, verb: 'may-edit' });
  deps.history.pushDoor('scope wire', async () => { for (const p of datasetGrantPatterns(target.label)) await desk.revokeImpact(deps.orgId, agent.id, p); revert(); return { ok: true }; });
}

/** Screen to screen: a link text at the source's root end leads to the target (the flow wire draws from it). */
async function wireScreens(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed): Promise<void> {
  const from = store.screenOf(source.id);
  const to = store.screenOf(target.id);
  if (from === undefined || to === undefined || !from.loaded) { deps.speakRefusal(at, 'that view is not ready to wire yet'); return; }
  const taken = new Set(store.elementsOf(from.slug).map((e) => e.node.id));
  const rail = store.childrenOf(from.slug, 'root');
  const last = rail.length > 0 ? store.element(from.slug, rail[rail.length - 1]!)?.node.order ?? null : null;
  const node = flowLinkNode(freshId(`go-${to.slug}`, taken), to.slug, to.title, keyBetween(last, null));
  const res = await deps.history.transaction('flow wire', () => store.put([{ typeName: 'element', id: store.elementId(from.slug, node.id), scene: from.slug, node }], 'user'));
  if (!res.ok) deps.speakRefusal(at, res.sentence);
}

/** A Result onto a screen: the registered output's asset binding lands; a text names it until a chart reads it. */
async function bindOutputToScene(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed): Promise<void> {
  const slug = store.sceneSlugOf(target.id);
  if (slug === null) return;
  const rows = await desk.listBindableOutputs(deps.orgId).catch(() => []);
  const row = rows.find((r) => r.name === source.label);
  if (row === undefined) { deps.speakRefusal(at, 'that result has no registered data yet - run its tool once'); return; }
  const revert = store.bornEdge({ from: source.id, to: target.id, verb: 'shows' });
  const res = await desk.humanSetBinding(deps.orgId, slug, row.binding);
  if (!res.ok) { revert(); deps.speakRefusal(at, res.error); return; }
  deps.history.pushDoor('binding', async () => { const r = await desk.humanRemoveBinding(deps.orgId, slug, row.name); revert(); return r.ok ? { ok: true } : { ok: false, sentence: r.error }; });
  deps.quiet(`connected - '${row.name}' is a query of this screen now; a chart or a frame reads it from the editor`);
}

async function retargetWatcherToIntegration(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed): Promise<void> {
  const triggerId = source.id.slice('trg:'.length);
  const rows = await desk.listTriggers(deps.orgId).catch(() => []);
  const trig = rows.find((t) => t.id === triggerId);
  if (trig === undefined) { deps.speakRefusal(at, 'that watcher is already gone'); return; }
  const connectionId = target.id.slice('intg:'.length);
  const resolved = await resolveConnectionDoors(deps.orgId, deps.projectId, connectionId);
  if (resolved === null) { deps.speakRefusal(at, NO_DOORS_SENTENCE); return; }
  pickConnectionDoor({
    resolved, projectId: deps.projectId, say: (s) => deps.speakRefusal(at, s),
    onDoor: (endpoint) => void (async () => {
      const res = await desk.humanMintTrigger(deps.orgId, trig.kind, trig.spec, { type: 'call_integration', connection: connectionId, endpoint, params: {} }, deps.projectId ?? undefined);
      if (!res.ok) { deps.speakRefusal(at, res.error ?? 'the trigger could not be rewired'); return; }
      await desk.deleteTrigger(deps.orgId, triggerId).catch(() => undefined);
      if (res.data) {
        store.markGone([source.id]);
        watcherMinted(deps, { triggerId: res.data.triggerId, kind: trig.kind, connectionId }, deps.projectId);
      }
    })(),
  });
}

export interface WatcherMintedLike { triggerId: string; kind: string; dataset?: string; operation?: string; connectionId?: string; flowStep?: string }

/** A minted watcher's card and edges render from the mint answer; undo deletes it. */
export function watcherMinted(deps: Pick<WireLaneDeps, 'orgId' | 'history'>, minted: WatcherMintedLike, projectId: string | null): string {
  const tid = `trg:${minted.triggerId}`;
  store.bornNode({ id: tid, kind: 'trigger', label: minted.kind.replace(/_/g, ' '), word: triggerKindWord(minted.kind), detail: null, lastActivityAt: null, projectId }, [
    ...(minted.dataset !== undefined ? [{ from: tid, to: `ds:${minted.dataset}`, verb: 'watches' }] : []),
    ...(minted.operation !== undefined ? [{ from: tid, to: `op:${minted.operation}`, verb: 'runs' }] : []),
    ...(minted.connectionId !== undefined ? [{ from: tid, to: `intg:${minted.connectionId}`, verb: 'runs' }] : []),
    ...(minted.flowStep !== undefined ? [{ from: tid, to: minted.flowStep, verb: 'runs' }] : []),
  ]);
  deps.history.pushDoor('watcher', async () => { await desk.deleteTrigger(deps.orgId, minted.triggerId); store.markGone([tid]); return { ok: true }; });
  return tid;
}

async function retargetTriggerToStep(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed): Promise<void> {
  const triggerId = source.id.slice('trg:'.length);
  const [, flowId, stepId] = target.id.split(':');
  if (flowId === undefined || stepId === undefined) return;
  const [rows, flows] = await Promise.all([desk.listTriggers(deps.orgId).catch(() => []), desk.flowsList(deps.orgId, deps.projectId ?? undefined).catch(() => [])]);
  const trig = rows.find((t) => t.id === triggerId);
  const flowName = flows.find((f) => f.id === flowId)?.name;
  if (trig === undefined || flowName === undefined) { deps.speakRefusal(at, 'that watcher is already gone'); return; }
  const res = await desk.humanMintTrigger(deps.orgId, trig.kind, trig.spec, { type: 'start_flow', flow: flowName, entry: stepId }, deps.projectId ?? undefined);
  if (!res.ok || res.data === undefined) { deps.speakRefusal(at, !res.ok ? res.error : 'the trigger could not be rewired'); return; }
  await desk.deleteTrigger(deps.orgId, triggerId).catch(() => undefined);
  store.markGone([source.id]);
  watcherMinted(deps, { triggerId: res.data.triggerId, kind: trig.kind, flowStep: target.id }, deps.projectId);
}

async function landTableOnStep(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed): Promise<void> {
  const [, flowId, stepId] = target.id.split(':');
  if (flowId === undefined || stepId === undefined) return;
  const flows = await desk.flowsList(deps.orgId, deps.projectId ?? undefined).catch(() => []);
  const doc = (flows.find((f) => f.id === flowId)?.doc ?? null) as { steps?: Record<string, { kind?: string }> } | null;
  const kind = doc?.steps?.[stepId]?.kind;
  if (kind === 'get-rows' || kind === 'save-rows') {
    const res = await desk.flowsSetStepParams(deps.orgId, flowId, stepId, { table: source.label });
    if (!res.ok) { deps.speakRefusal(at, res.error); return; }
    if (kind === 'get-rows') store.bornEdge({ from: source.id, to: target.id, verb: 'feeds' }); else store.bornEdge({ from: target.id, to: source.id, verb: 'updates' });
    return;
  }
  const bridge = await deps.placeStep('get-rows', { x: at.x - 160, y: at.y }, { table: source.label }, true);
  if (bridge === null) return;
  const bStep = bridge.split(':')[2]!;
  const res = await desk.flowsWireSteps(deps.orgId, flowId, bStep, stepId);
  if (!res.ok || res.data === undefined) { deps.speakRefusal(at, !res.ok ? res.error : 'the wire would not land'); return; }
  deps.history.pushDoor('get rows', async () => { await desk.flowsRemoveStep(deps.orgId, flowId, bStep); store.markGone([bridge]); return { ok: true }; });
  store.bornEdge({ from: source.id, to: bridge, verb: 'feeds' });
  store.bornEdge({ from: bridge, to: target.id, verb: 'feeds', port: res.data.port, slot: res.data.slot });
}

async function landFusedToolWire(deps: WireLaneDeps, source: LaneNode, target: LaneNode, at: Placed, direction: 'step-to-tool' | 'tool-to-step'): Promise<void> {
  const stepEnd = direction === 'step-to-tool' ? source : target;
  const toolEnd = direction === 'step-to-tool' ? target : source;
  const [, flowId, stepId] = stepEnd.id.split(':');
  if (flowId === undefined || stepId === undefined) return;
  const fused = await deps.placeStep('run-tool', undefined, { tool: opName(toolEnd.label), fused: true }, true);
  if (fused === null) return;
  const fStep = fused.split(':')[2]!;
  const res = direction === 'step-to-tool' ? await desk.flowsWireSteps(deps.orgId, flowId, stepId, fStep) : await desk.flowsWireSteps(deps.orgId, flowId, fStep, stepId);
  if (!res.ok || res.data === undefined) { deps.speakRefusal(at, !res.ok ? res.error : 'the wire would not land'); return; }
  deps.history.pushDoor('run tool', async () => { await desk.flowsRemoveStep(deps.orgId, flowId, fStep); return { ok: true }; });
  store.bornEdge({ from: source.id, to: target.id, verb: 'feeds', port: res.data.port, slot: res.data.slot, via: fused });
}

/** The picker's landing: the mode-shaped write through the human doors. */
export async function pickerLanded(deps: WireLaneDeps, picker: LanePicker, payload: PickerPayload, landData: (slug: string, dataset: string, payload: PickerPayload) => Promise<void>): Promise<void> {
  const { source, target, mode } = picker;
  if (mode === 'binding') {
    const slug = payload.screenSlug ?? store.sceneSlugOf(target.id);
    if (slug === null) return;
    await landData(slug, source.label, payload);
    return;
  }
  if (mode === 'write-back' && payload.keyColumn !== undefined && picker.output !== undefined) {
    const name = opName(source.label);
    const output = picker.output;
    const res = await desk.humanBindOpOutput(deps.orgId, { operation: name, output, dataset: target.label, key: payload.keyColumn }, deps.projectId ?? undefined);
    if (!res.ok) { deps.quiet(res.error); return; }
    const revert = store.bornEdge({ from: source.id, to: target.id, verb: 'updates' });
    deps.history.pushDoor('write-back', async () => { const r = await desk.humanBindOpOutput(deps.orgId, { operation: name, output, clear: true }); revert(); return r.ok ? { ok: true } : { ok: false, sentence: r.error }; });
    return;
  }
  if (mode === 'op-run') {
    const name = opName(target.label);
    const contract = await desk.operationContract(deps.orgId, name);
    const inputs = inputsFor({ kind: 'operation', label: target.label, contract: contract ?? undefined }, source.label);
    const run = await desk.humanRunOperation(deps.orgId, name, inputs, deps.projectId ?? undefined);
    if (!run.ok) { deps.quiet(run.error); return; }
    if (payload.keepUpdated === true) {
      const chain = await desk.humanMintChain(deps.orgId, name, inputs, deps.projectId ?? undefined);
      if (!chain.ok) deps.quiet(chain.error); else if (chain.data) echoChain(deps, chain.data.chainId, source, target);
    }
    return;
  }
  if (mode === 'app-action' && payload.buttonLabel !== undefined) {
    // A button on the screen starts the flow at a fused run-tool step for the tool (a tool runs inside a flow).
    const slug = store.sceneSlugOf(source.id);
    const screen = slug !== null ? store.screenBySlugOf(slug) : undefined;
    if (slug === null || screen === undefined) return;
    const fused = await deps.placeStep('run-tool', undefined, { tool: opName(target.label), fused: true }, true);
    if (fused === null) return;
    const [, flowId, stepId] = fused.split(':');
    const flows = await desk.flowsList(deps.orgId, deps.projectId ?? undefined).catch(() => []);
    const flowName = flows.find((f) => f.id === flowId)?.name;
    if (flowId === undefined || stepId === undefined || flowName === undefined) return;
    await landButton(deps, screen.slug, payload.buttonLabel, { kind: 'start-flow', ...(flowName === 'main' ? {} : { flow: flowName }), entry: stepId, label: opName(target.label) });
    store.bornEdge({ from: source.id, to: target.id, verb: 'runs', action: undefined });
  }
}

/** Births a button (a frame with a text) at the screen's root end and declares its action. */
async function landButton(deps: WireLaneDeps, slug: string, label: string, write: Parameters<typeof declareAction>[0]['write']): Promise<void> {
  const taken = new Set(store.elementsOf(slug).map((e) => e.node.id));
  const rail = store.childrenOf(slug, 'root');
  const last = rail.length > 0 ? store.element(slug, rail[rail.length - 1]!)?.node.order ?? null : null;
  const id = freshId(`btn-${label}`, taken);
  const frame: ElementRecord['node'] = { id, parent: 'root', order: keyBetween(last, null), components: { [primitiveRef('frame')]: { layout: 'row', align: 'center', x: 24, y: 24, padding: { top: 8, right: 16, bottom: 8, left: 16 }, fill: 'primary', 'border-radius': 'capsule' } } };
  const text: ElementRecord['node'] = { id: `${id}-label`, parent: id, order: keyBetween(null, null), components: { [primitiveRef('text')]: { text: label, 'font-weight': 500 } } };
  const acts = await desk.sceneActions(deps.orgId, slug).catch(() => []);
  const declared = declareAction({ node: frame, buttonWord: label, write, takenNames: new Set(acts.map((a) => a.name)) });
  if (declared === null) return;
  const res = await desk.humanSetAction(deps.orgId, slug, declared.action);
  if (!res.ok) { deps.quiet(res.error); return; }
  const landed = await deps.history.transaction('button', () => store.put([
    { typeName: 'element', id: store.elementId(slug, id), scene: slug, node: declared.node },
    { typeName: 'element', id: store.elementId(slug, text.id), scene: slug, node: text },
  ], 'user'));
  if (!landed.ok) deps.quiet('declared - add a button from the editor to fire it');
}

// ---------------------------------------------------------------------------
// The element lane: an element wired out onto a citizen (the element-port law over the five).
// ---------------------------------------------------------------------------

export interface ElementAttachCtx {
  orgId: string;
  projectId: string | null;
  scene: string;
  history: History;
  say: (sentence: string) => void;
  placeStep: WireLaneDeps['placeStep'];
}

export const elementClassOfNode = (node: ElementRecord['node']): ElementClass => {
  const prim = primitiveOfNode(node);
  if (prim === null) return 'display';
  if (prim.name === 'frame') {
    const a = prim.payload['action'];
    if (typeof a === 'object' && a !== null) return 'goto' in (a as object) || 'href' in (a as object) ? 'nav' : 'action';
    return 'display';
  }
  if (prim.name === 'text') return typeof prim.payload['href'] === 'string' ? 'nav' : 'display';
  if (prim.name === 'field') return 'action';
  return 'display';
};

/** The element attached to a citizen through the element-port law; true = the pair was legal and the write ran. */
export async function attachElement(ctx: ElementAttachCtx, el: ElementRecord, cls: ElementClass, choice: { kind: string; label: string; id: string }): Promise<boolean> {
  const rule = elementPortRule(cls, choice.kind);
  if (rule === null) { ctx.say('nothing here can legally connect'); return false; }
  const prim = primitiveOfNode(el.node);
  if (prim === null) { ctx.say('nothing here can legally connect'); return false; }
  const put = (node: ElementRecord['node'], label: string): Promise<{ ok: boolean }> => ctx.history.transaction(label, () => store.put([{ ...el, node }], 'user'));
  const payloadWith = (patch: Record<string, unknown>): ElementRecord['node'] => ({ ...el.node, components: { ...el.node.components, [prim.ref]: { ...prim.payload, ...patch } } });
  const resolveScene = (nodeId: string): { slug: string; title: string } | null => { const s = store.screenOf(nodeId); return s === undefined ? null : { slug: s.slug, title: s.title }; };

  if (rule.write === 'nav-item' || rule.write === 'button-nav') {
    const target = resolveScene(choice.id);
    if (target === null) { ctx.say('that view lives in another project'); return true; }
    if (prim.name === 'text') await put(payloadWith({ href: `screen:${target.slug}` }), `go to ${target.title}`);
    else await put(payloadWith({ action: { goto: target.slug } }), `go to ${target.title}`);
    return true;
  }
  if (rule.write === 'row-nav') {
    const eachFrame = nearestEach(ctx.scene, el);
    if (eachFrame === null) { ctx.say('only a frame repeating rows opens a view per row - give it each first'); return true; }
    const query = eachQueryOf(eachFrame.node);
    if (query === null) { ctx.say('connect this to a table first - its rows are what travel'); return true; }
    const target = resolveScene(choice.id);
    if (target === null) { ctx.say('that view lives in another project'); return true; }
    const bindings = await desk.sceneBindings(ctx.orgId, ctx.scene).catch(() => []);
    const binding = bindings.find((b) => b.name === query);
    const table = binding !== undefined && binding.kind === 'query' ? binding.table : query;
    const brief = await desk.datasetBrief(ctx.orgId, table, ctx.projectId ?? undefined);
    if (brief.columns.length === 0) { ctx.say(`couldn't read ${table}'s columns in this project`); return true; }
    pickColumn({
      headline: 'Which column names the row?', columns: brief.columns.map((c) => ({ key: c.key, display: c.display })), projectId: ctx.projectId, say: ctx.say,
      onColumn: (col) => void (async () => {
        const standing = await desk.sceneBindings(ctx.orgId, target.slug).catch(() => []);
        const prior = standing.find((b) => b.kind === 'query' && b.table === table);
        if (prior === undefined || prior.kind !== 'query' || prior.rowKey?.column !== col) {
          const rowSchema: Record<string, 'string' | 'number' | 'boolean'> = {};
          for (const c of brief.columns) rowSchema[c.key] = c.type;
          const res = await desk.humanSetBinding(ctx.orgId, target.slug, prior !== undefined && prior.kind === 'query' ? { ...prior, rowKey: { column: col } } : { name: table, kind: 'query', table, rowSchema, rowKey: { column: col } });
          if (!res.ok) { ctx.say(res.error); return; }
        }
        const rail = store.childrenOf(ctx.scene, eachFrame.node.id);
        const last = rail.length > 0 ? store.element(ctx.scene, rail[rail.length - 1]!)?.node.order ?? null : null;
        const taken = new Set(store.elementsOf(ctx.scene).map((e) => e.node.id));
        const btn = rowNavNode(freshId(`${eachFrame.node.id}-open`, taken), eachFrame.node.id, keyBetween(last, null), target.slug, col);
        const word: ElementRecord['node'] = { id: `${btn.id}-word`, parent: btn.id, order: keyBetween(null, null), components: { [primitiveRef('text')]: { text: 'Open', 'font-size': 'small' } } };
        const r = await ctx.history.transaction('open a view per row', () => store.put([
          { typeName: 'element', id: store.elementId(ctx.scene, btn.id), scene: ctx.scene, node: btn },
          { typeName: 'element', id: store.elementId(ctx.scene, word.id), scene: ctx.scene, node: word },
        ], 'user'));
        if (r.ok) ctx.say(`clicking a row opens ${target.title} with that row`);
      })(),
    });
    return true;
  }
  if (rule.write === 'element-binding') {
    const brief = await desk.datasetBrief(ctx.orgId, choice.label, ctx.projectId ?? undefined);
    if (brief.columns.length === 0) { ctx.say(`couldn't read ${choice.label}'s columns in this project - if it lives in another project, copy it in first`); return true; }
    const rowSchema: Record<string, 'string' | 'number' | 'boolean'> = {};
    for (const c of brief.columns) rowSchema[c.key] = c.type;
    const res = await desk.humanSetBinding(ctx.orgId, ctx.scene, { name: choice.label, kind: 'query', table: choice.label, rowSchema });
    if (!res.ok) { ctx.say(res.error); return true; }
    if (prim.name === 'chart') { await put(payloadWith({ query: choice.label }), `chart over ${choice.label}`); return true; }
    if (prim.name === 'frame') {
      const rows = store.childrenOf(ctx.scene, el.node.id);
      const eachValue = typeof prim.payload['each'] === 'object' && prim.payload['each'] !== null ? { ...(prim.payload['each'] as Record<string, unknown>), query: choice.label } : { query: choice.label, empty: 'No rows yet' };
      const puts: ElementRecord[] = [{ ...el, node: payloadWith({ each: eachValue }) }];
      if (rows.length === 0) {
        let lo: string | null = null;
        for (const c of brief.columns.slice(0, 3)) {
          lo = keyBetween(lo, null);
          const id = freshId(`${el.node.id}-${c.key}`, new Set(store.elementsOf(ctx.scene).map((e) => e.node.id)));
          puts.push({ typeName: 'element', id: store.elementId(ctx.scene, id), scene: ctx.scene, node: { id, parent: el.node.id, order: lo, components: { [primitiveRef('text')]: { text: { $expr: `row('${c.key}')`, deps: [`bindings.${choice.label}`] } } } } });
        }
      }
      await ctx.history.transaction(`repeat over ${choice.label}`, () => store.put(puts, 'user'));
      return true;
    }
    if (prim.name === 'field' && (prim.payload['kind'] === 'select' || prim.payload['kind'] === 'multi-select' || prim.payload['kind'] === 'radio')) {
      const first = brief.columns.find((c) => c.type === 'string') ?? brief.columns[0]!;
      await put(payloadWith({ options: { query: choice.label, label: first.key, value: first.key } }), 'options from a table');
      return true;
    }
    if (prim.name === 'field' && prim.payload['kind'] === 'search') {
      await put(payloadWith({ filters: { query: choice.label, columns: brief.columns.filter((c) => c.type === 'string').map((c) => c.key).slice(0, 3) } }), 'search a table');
      return true;
    }
    ctx.say(`${choice.label} is a query of this screen now - a chart, a frame with each, or a select field reads it`);
    return true;
  }
  if (rule.write === 'param-feed') {
    ctx.say('a connection runs inside a flow now - wire this field\'s button to a step, the flow reads the value');
    return true;
  }
  if (rule.write === 'action-propose') {
    ctx.say('ask the assistant from the chat - a button cannot start it from the screen');
    return true;
  }
  if (prim.name !== 'frame') { ctx.say('only a frame with an action (a button) does this'); return true; }
  const children = store.childrenOf(ctx.scene, el.node.id).map((id) => store.element(ctx.scene, id)?.node).filter((n): n is ElementRecord['node'] => n !== undefined);
  const buttonWord = buttonWordOf(el.node, children);
  const landAction = async (write: Parameters<typeof declareAction>[0]['write']): Promise<void> => {
    const taken = new Set((await desk.sceneActions(ctx.orgId, ctx.scene).catch(() => [])).map((a) => a.name));
    const out = declareAction({ node: el.node, buttonWord, write, takenNames: taken });
    if (out === null) { ctx.say('nothing here can legally connect'); return; }
    const res = await desk.humanSetAction(ctx.orgId, ctx.scene, out.action);
    if (!res.ok) { ctx.say(res.error); return; }
    ctx.history.pushDoor(out.action.title, async () => { const r = await desk.humanRemoveAction(ctx.orgId, ctx.scene, out.action.name); return r.ok ? { ok: true } : { ok: false, sentence: r.error }; });
    const r = await put(out.node, out.action.title);
    if (r.ok) ctx.say(write.kind === 'append' ? `saves to ${write.table.replace(/-/g, ' ')} when clicked` : `starts ${write.label} when clicked`);
  };
  if (rule.write === 'action-append') {
    const brief = await desk.datasetBrief(ctx.orgId, choice.label, ctx.projectId ?? undefined);
    await landAction({ kind: 'append', table: choice.label, columns: brief.columns.map((c) => ({ key: c.key, type: c.type })) });
    return true;
  }
  if (rule.write === 'action-start-flow') {
    const [prefix, flowId, stepId] = choice.id.split(':');
    if (prefix !== 'fstep' || flowId === undefined || stepId === undefined) { ctx.say('nothing here can legally connect'); return false; }
    const flows = await desk.flowsList(ctx.orgId, ctx.projectId ?? undefined).catch(() => []);
    const flowName = flows.find((f) => f.id === flowId)?.name;
    if (flowName === undefined) { ctx.say('that flow is gone'); return true; }
    await landAction({ kind: 'start-flow', ...(flowName === 'main' ? {} : { flow: flowName }), entry: stepId, label: choice.label });
    return true;
  }
  if (rule.write === 'action-run') {
    // A tool runs inside a flow: a fused run-tool step is placed and the button starts the flow at it.
    const fused = await ctx.placeStep('run-tool', undefined, { tool: opName(choice.label), fused: true }, true);
    if (fused === null) return true;
    const [, flowId, stepId] = fused.split(':');
    const flows = await desk.flowsList(ctx.orgId, ctx.projectId ?? undefined).catch(() => []);
    const flowName = flows.find((f) => f.id === flowId)?.name;
    if (flowId === undefined || stepId === undefined || flowName === undefined) return true;
    await landAction({ kind: 'start-flow', ...(flowName === 'main' ? {} : { flow: flowName }), entry: stepId, label: opName(choice.label) });
    return true;
  }
  if (rule.write === 'action-call') {
    const connectionId = choice.id.startsWith('intg:') ? choice.id.slice('intg:'.length) : choice.id;
    const resolved = await resolveConnectionDoors(ctx.orgId, ctx.projectId, connectionId);
    if (resolved === null) { ctx.say(NO_DOORS_SENTENCE); return true; }
    pickConnectionDoor({
      resolved, projectId: ctx.projectId, say: ctx.say,
      onDoor: (endpoint) => void (async () => {
        const step = await ctx.placeStep('call-integration', undefined, { connection: connectionId, endpoint, fused: true }, true);
        if (step === null) return;
        const [, flowId, stepId] = step.split(':');
        const flows = await desk.flowsList(ctx.orgId, ctx.projectId ?? undefined).catch(() => []);
        const flowName = flows.find((f) => f.id === flowId)?.name;
        if (flowId === undefined || stepId === undefined || flowName === undefined) return;
        await landAction({ kind: 'start-flow', ...(flowName === 'main' ? {} : { flow: flowName }), entry: stepId, label: resolved.doors.find((d) => d.id === endpoint)?.word ?? choice.label });
      })(),
    });
    return true;
  }
  ctx.say('nothing here can legally connect');
  return false;
}

/** The nearest frame with each: the element itself or an ancestor. */
function nearestEach(scene: string, el: ElementRecord): ElementRecord | null {
  let cur: ElementRecord | undefined = el;
  for (let hops = 0; cur !== undefined && hops < 64; hops += 1) {
    if (eachQueryOf(cur.node) !== null || (primitiveOfNode(cur.node)?.name === 'frame' && cur.node.parent === null)) return cur;
    cur = cur.node.parent !== null ? store.element(scene, cur.node.parent) : undefined;
  }
  return null;
}

export function eachQueryOf(node: ElementRecord['node']): string | null {
  const prim = primitiveOfNode(node);
  if (prim === null || prim.name !== 'frame') return null;
  const each = prim.payload['each'];
  if (typeof each === 'string') return each;
  if (typeof each === 'object' && each !== null && typeof (each as Record<string, unknown>)['query'] === 'string') return (each as Record<string, string>)['query']!;
  return null;
}

/** The element-out drop on a citizen (or the browser's question on empty space). */
export async function elementWireOut(ctx: ElementAttachCtx, el: ElementRecord, cls: ElementClass, target: NodeRecord | null): Promise<void> {
  if (target !== null) { await attachElement(ctx, el, cls, { kind: target.kind, label: target.label, id: target.id }); return; }
  const noun = elementWordOf(el);
  const opened = store.openBrowser({
    mode: 'wire',
    headline: cls === 'nav' ? 'Where should this lead?' : cls === 'display' ? 'What should this show?' : 'What should this button do?',
    element: { cls, label: noun }, projectId: ctx.projectId,
    onPick: (choice) => void (async () => {
      if (choice.pick === 'node') { await attachElement(ctx, el, cls, choice); return; }
      if (choice.pick === 'insert' && choice.kind === 'view' && cls === 'nav') {
        const size = { w: 1440, h: 900 };
        const r = await desk.humanInsertScene(ctx.orgId, 'New view', size, ctx.projectId ?? undefined);
        if (!r.ok || r.data === undefined) { if (!r.ok) ctx.say(r.error); return; }
        const prim = primitiveOfNode(el.node);
        if (prim === null) return;
        const node = prim.name === 'text' ? { ...el.node, components: { ...el.node.components, [prim.ref]: { ...prim.payload, href: `screen:${r.data.slug}` } } } : { ...el.node, components: { ...el.node.components, [prim.ref]: { ...prim.payload, action: { goto: r.data.slug } } } };
        await ctx.history.transaction('go to a new view', () => store.put([{ ...el, node }], 'user'));
        return;
      }
      if (choice.pick === 'insert') ctx.say('name it on the canvas first, then wire it from here');
    })(),
  });
  if (!opened) ctx.say('open the side panel to answer');
}

export function elementWordOf(el: ElementRecord): string {
  const prim = primitiveOfNode(el.node);
  if (prim === null) return 'this element';
  if (typeof prim.payload['label'] === 'string') return prim.payload['label'];
  if (typeof prim.payload['text'] === 'string') return prim.payload['text'];
  return 'this element';
}

/** The citizens an element class may wire to (the browser's targets when it lights). */
export function legalCitizenTargetsFor(cls: ElementClass): string[] {
  return legalTargets('scene').length >= 0 ? ['scene', 'website', 'dataset', 'operation', 'integration', 'step', 'role'].filter((k) => elementPortRule(cls, k) !== null) : [];
}

export type { Editor };
