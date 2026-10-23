import { Columns3, Link2, ListPlus } from 'lucide-react';
import { elementPortRule, primitiveRef } from '@tent-nocode/core';
import type { CitizenKind, ElementClass } from '@tent-nocode/core';
import { elementToolbarFor } from '../../lib/canvas/store.js';
import { desk } from '../../lib/desk.js';
import { store } from '../../lib/canvas/store.js';
import type { NodeBrowserPick } from '../../lib/canvas/store.js';
import { attachElement } from '../../lib/canvas/tools/select/DrawingWire.js';
import type { ElementAttachCtx } from '../../lib/canvas/tools/select/DrawingWire.js';
import { pickColumn } from '../../lib/page-edit/endpointPick.js';
import { flowLinkNode, freshId } from '../../lib/page-edit/flowWires.js';
import { formFieldNodes } from '../../lib/page-edit/actionWires.js';
import { activeEditor } from '../canvas/CanvasEngine.js';
import type { FlowNodeLike } from '../../lib/page-edit/flowWires.js';
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
const createOp = (n: { id: string; parent: string | null; order: string; components: Record<string, Record<string, unknown>> }, anchor: { anchor: 'end' } | { anchor: 'after'; ref: string }): SceneOpLike =>
  ({ op: 'create_node', id: n.id, parent: n.parent ?? 'root', position: anchor, components: n.components });
import { attachButton, doorButton, newViewButton, propsButton } from '../canvas/ActionToolbar.js';
import type { ToolbarButton } from '../canvas/ActionToolbar.js';

// Element attach/nav doors; pure plumbing, every write rides the host's one commit path.

export interface ElementDoorCtx {
  orgId: string;
  editSlug: string;
  projectId: string | null;
  size: { w: number; h: number };
  /** The host's one commit path; false = refused. */
  commitDirect: (edit: GestureEdit) => Promise<boolean>;
  quietSay: (sentence: string) => void;
  /** Walks the running app to a slug. */
  navTo: (slug: string) => void;
  /** Opens the section picker for a nav element's "lead to a section" door. */
  pickSection?: (el: FlowNodeLike) => void;
  /** The catalog's param contracts — the attach feed targets the ref declaring `binding`. */
  paramsOf?: (ref: string) => ReadonlyArray<{ name: string }> | undefined;
}

export function elementWord(el: FlowNodeLike): string {
  for (const payload of Object.values(el.components)) {
    if (typeof payload['label'] === 'string' && payload['label'] !== '') return payload['label'];
  }
  return 'this element';
}

function attachCtx(ctx: ElementDoorCtx): ElementAttachCtx {
  return {
    orgId: ctx.orgId, projectId: ctx.projectId, scene: ctx.editSlug,
    get history() { return activeEditor.get()!.history; },
    say: ctx.quietSay,
    placeStep: async () => { ctx.quietSay('place the step from the workspace'); return null; },
  };
}

function attachPick(ctx: ElementDoorCtx, el: FlowNodeLike, cls: ElementClass): (choice: NodeBrowserPick) => void {
  return (choice) => {
    void (async () => {
      if (choice.pick !== 'node') { ctx.quietSay('name it on the bench first, then attach it from here'); return; }
      const record = store.element(ctx.editSlug, el.id);
      if (record === undefined) { ctx.quietSay('that element is not on the canvas any more'); return; }
      await attachElement(attachCtx(ctx), record, cls, choice);
    })();
  };
}

export function openAttach(ctx: ElementDoorCtx, el: FlowNodeLike, cls: ElementClass, target: CitizenKind): void {
  const rule = elementPortRule(cls, target);
  const took = store.openBrowser({
    mode: 'wire',
    headline: rule?.write === 'nav-item' ? 'Where should this lead?'
      : cls === 'display' ? 'What should this show?' : 'What should this button do?',
    element: { cls, label: elementWord(el) }, projectId: ctx.projectId,
    onPick: attachPick(ctx, el, cls),
  });
  if (!took) ctx.quietSay('the node browser has no panel to open in');
}

/** Builds the selected element's toolbar buttons from the element-port law. */
export function pinnedToolbarFor(ctx: ElementDoorCtx, el: FlowNodeLike, cls: ElementClass, opts: {
  mounted: { id: string; slug: string; title: string } | null;
  fire: (nodeId: string) => void;
  /** Enclosing repeat template's binding name; present lights the "Show a column" door. */
  repeatBinding?: string | null;
}): ToolbarButton[] {
  const out: ToolbarButton[] = [];
  for (const item of elementToolbarFor(cls)) {
    if (item.act === 'run') {
      out.push(doorButton('run-operation', () => opts.fire(el.id)));
    } else if (item.act === 'props' && opts.mounted !== null) {
      const m = opts.mounted;
      out.push(propsButton(() => store.openInspector({ sceneId: m.id, sceneSlug: m.slug, sceneTitle: m.title, nodeId: el.id })));
    } else if (item.act === 'attach') {
      out.push(attachButton(item.target, item.word, () => openAttach(ctx, el, cls, item.target)));
    } else if (item.act === 'new-view') {
      out.push(newViewButton(() => void newViewUnder(ctx, el)));
    }
  }
  // A nav-class element may also lead to a section of this page.
  if (cls === 'nav' && ctx.pickSection !== undefined) {
    const pick = ctx.pickSection;
    out.push({ key: 'section-link', icon: Link2, label: 'Lead to a section of this page', onAct: () => pick(el) });
  }
  // "Make the form": a wired button derives its input fields.
  if (cls === 'action' && Object.values(el.components).some((p) => typeof p['action'] === 'string' && p['action'] !== '')) {
    out.push({ key: 'make-form', icon: ListPlus, label: 'Make the form', onAct: () => void makeTheForm(ctx, el) });
  }
  // "Show a column": only a text element inside a repeat template gets this door.
  const repeatBinding = opts.repeatBinding ?? null;
  if (repeatBinding !== null && repeatBinding !== ''
    && Object.keys(el.components).includes(primitiveRef('text'))) {
    out.push({ key: 'show-column', icon: Columns3, label: 'Show a column', onAct: () => void showColumn(ctx, el, repeatBinding) });
  }
  return out;
}

/** Picks a column of the repeat binding and writes text as a row() expression. */
export async function showColumn(ctx: ElementDoorCtx, el: FlowNodeLike, binding: string): Promise<void> {
  const ref = Object.keys(el.components).find((r) => r === primitiveRef('text'));
  if (ref === undefined) { ctx.quietSay('only a text element shows a column'); return; }
  const brief = await desk.datasetBrief(ctx.orgId, binding, ctx.projectId ?? undefined).catch(() => null);
  if (brief === null || brief.columns.length === 0) {
    ctx.quietSay(`couldn't read ${binding}'s columns in this project — if it lives in another project, copy it in first`);
    return;
  }
  pickColumn({
    headline: 'Show which column?',
    columns: brief.columns.map((c) => ({ key: c.key, display: c.display })),
    projectId: ctx.projectId, say: ctx.quietSay,
    onColumn: (col) => {
      void ctx.commitDirect(compileParamEdit({
        nodeId: el.id, component: ref, key: 'text',
        value: { $expr: `row('${col}')`, deps: [`bindings.${binding}`] },
        storedPayload: el.components[ref] ?? {},
      }));
    },
  });
}

/** Derives form fields from the wired action's user-source params. */
export async function makeTheForm(ctx: ElementDoorCtx, el: FlowNodeLike): Promise<void> {
  const actionName = Object.values(el.components)
    .map((p) => p['action'])
    .find((v): v is string => typeof v === 'string' && v !== '');
  if (actionName === undefined) { ctx.quietSay('wire this button first — the form derives from what it does'); return; }
  const docs = await desk.sceneActions(ctx.orgId, ctx.editSlug).catch(() => []);
  const doc = docs.find((a) => a.name === actionName);
  const params = (doc?.params ?? []).filter((p) => p.source === 'user');
  if (doc === undefined || params.length === 0) { ctx.quietSay('this button asks for nothing — no fields to make'); return; }
  const me = await desk.sceneNode(ctx.orgId, ctx.editSlug, el.id).catch(() => null);
  const parent = me?.node?.parent ?? 'root';
  // Collect existing param collectors and ids so no twin field is minted.
  const scope = await desk.sceneSubtree(ctx.orgId, ctx.editSlug, parent, 4).catch(() => null);
  const taken = new Set<string>();
  const ids = new Set<string>();
  const walk = (n: unknown): void => {
    if (typeof n !== 'object' || n === null) return;
    const node = n as { id?: unknown; components?: Record<string, Record<string, unknown>>; children?: unknown[] };
    if (typeof node.id === 'string') ids.add(node.id);
    for (const payload of Object.values(node.components ?? {})) {
      const v = payload['param'];
      if (typeof v === 'string' && v !== '') taken.add(v);
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(scope?.subtree ?? null);
  const nodes = formFieldNodes({ parent, params, taken, existingIds: ids, orderAfter: (i) => `z${String(i).padStart(4, '0')}` });
  const ops = nodes.map((n) => createOp(n, { anchor: 'end' }));
  if (ops.length === 0) { ctx.quietSay('every field is already on the page'); return; }
  const res = await desk.sceneApplyOps(ctx.orgId, ctx.editSlug, ops).catch(() => null);
  if (res === null || !res.ok || (res.data !== undefined && !res.data.ok)) {
    const words = res !== null && res.ok && res.data !== undefined && !res.data.ok ? res.data.errors.join(' · ') : 'the form would not land';
    ctx.quietSay(words);
    return;
  }
  ctx.quietSay(`the form landed — ${ops.length} field${ops.length === 1 ? '' : 's'}`);
}

/** Births a new view, wires this nav element to it, and walks the app there. */
export async function newViewUnder(ctx: ElementDoorCtx, el: FlowNodeLike): Promise<void> {
  const r = await desk.humanInsertScene(ctx.orgId, 'New view', ctx.size, ctx.projectId ?? undefined);
  if (!r.ok || r.data === undefined) { if (!r.ok) ctx.quietSay(r.error); return; }
  const taken = new Set(store.elementsOf(ctx.editSlug).map((e) => e.node.id));
  const link = flowLinkNode(freshId('link', taken), r.data.slug, 'New view', 'z');
  const edit: GestureEdit = { ops: [createOp({ ...link, parent: el.id }, { anchor: 'end' })], inverse: [{ op: 'remove_node', id: link.id }], guards: [], label: 'lead to a new view' };
  await ctx.commitDirect(edit);
  ctx.navTo(r.data.slug);
}
