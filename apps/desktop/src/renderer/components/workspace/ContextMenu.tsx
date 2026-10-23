import type { VerbDoor } from '@tent-nocode/core';
import { createRows, hasOutPort, nodeMenu } from '../../lib/canvas/store.js';
import type { AddKind, Placed } from '../../lib/canvas/store.js';
import { ContextMenu } from '../canvas/ContextMenu.js';

// Right-click menu assembly: CREATE palette on empty canvas, VERB menu on nodes; wires to existing doors, never invents.

export type WorkspaceMenuState =
  | { kind: 'create'; client: Placed; canvasAt: Placed }
  | { kind: 'node'; client: Placed; nodeId: string; sel: ReadonlySet<string> };

export interface MenuNode { id: string; kind: string; label: string; projectId: string | null }

export function WorkspaceContextMenu({ menu, deps, onClose }: {
  menu: WorkspaceMenuState;
  onClose: () => void;
  deps: {
    viewWord: string;
    byId: ReadonlyMap<string, MenuNode>;
    foldDoorFor: (id: string, sel: ReadonlySet<string>) => { verb: 'fold' | 'unfold'; act: () => void } | null;
    // Creates a new citizen at the cursor spot.
    addCitizen: (kind: AddKind, at: Placed, client?: Placed) => void;
    // Placeable integrations from the catalog.
    integrations: Array<{ name: string; displayName: string }>;
    placeIntegration: (name: string, at: Placed) => void;
    // Placeable steps.
    steps: Array<{ kind: string; displayName: string }>;
    placeStep: (kind: string, at: Placed) => void;
    // Placeable doors (service endpoints).
    doors: Array<{ service: string; endpoint: string; displayName: string }>;
    placeDoor: (service: string, endpoint: string, at: Placed) => void;
    // Placeable triggers.
    triggers: Array<{ service: string; trigger: string; displayName: string }>;
    placeTrigger: (service: string, trigger: string, at: Placed) => void;
    openVerb: (n: MenuNode, door: VerbDoor) => void;
    openProps: (n: MenuNode) => void;
    connect: (n: MenuNode) => void;
    /** The one deletion lane (Del and this row are the same door). */
    deleteIds: (ids: ReadonlySet<string>) => void;
  };
}) {
  if (menu.kind === 'create') {
    return (
      <ContextMenu
        at={menu.client}
        groups={createRows(
          deps.viewWord,
          (k) => deps.addCitizen(k, menu.canvasAt, menu.client),
          deps.integrations,
          (name) => deps.placeIntegration(name, menu.canvasAt),
          deps.steps,
          (kind) => deps.placeStep(kind, menu.canvasAt),
          deps.doors,
          (service, endpoint) => deps.placeDoor(service, endpoint, menu.canvasAt),
          deps.triggers,
          (service, trigger) => deps.placeTrigger(service, trigger, menu.canvasAt),
        )}
        search="always"
        placeholder="Type to create…"
        onClose={onClose}
      />
    );
  }
  const full = deps.byId.get(menu.nodeId);
  const fold = deps.foldDoorFor(menu.nodeId, menu.sel);
  if (full === undefined && fold === null) return null; // a stale target — nothing honest to offer
  const groups = nodeMenu({
    nodeId: menu.nodeId,
    kind: full?.kind ?? '',
    fold,
    hasOut: full !== undefined && hasOutPort(full.kind),
    onVerb: (door) => { if (full !== undefined) deps.openVerb(full, door); },
    onProps: () => { if (full !== undefined) deps.openProps(full); },
    onConnect: () => { if (full !== undefined) deps.connect(full); },
    onDelete: () => deps.deleteIds(menu.sel),
  });
  return <ContextMenu at={menu.client} groups={groups} onClose={onClose} />;
}
