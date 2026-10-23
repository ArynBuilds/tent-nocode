import { useEffect } from 'react';
import { store } from './canvas/store.js';

/** The lens's half: the focused screen and the element the hand holds on it. */
export interface EditContext { sceneSlug: string; selectedId: string | null }
const currentEditing = (): EditContext | null => {
  const el = store.selectedElement();
  if (el !== null) return { sceneSlug: el.scene, selectedId: el.elementId };
  const focused = store.focused.get();
  return focused !== null ? { sceneSlug: focused.slug, selectedId: null } : null;
};

// Ambient selection truth: lens hand selection wins, else map's single citizen, else null.

export interface MapCitizenSelection { kind: string; nodeId: string; label: string }

export type AmbientSelection =
  | { surface: 'lens'; sceneSlug: string; nodeId: string }
  | { surface: 'map'; kind: string; nodeId: string; label: string }
  | null;

let mapCitizen: MapCitizenSelection | null = null;

/** The Map's half of the truth: the single selected citizen, or null (empty and
 * multi-select both read as no ONE citizen - the spec names one). */
export function publishMapCitizenSelection(sel: MapCitizenSelection | null): void {
  mapCitizen = sel;
}

/** Pure composition - the priority rule on its own, unit-testable without React. */
export function composeAmbientSelection(
  lens: Pick<EditContext, 'sceneSlug' | 'selectedId'> | null,
  map: MapCitizenSelection | null,
): AmbientSelection {
  if (lens !== null && lens.selectedId !== null) {
    return { surface: 'lens', sceneSlug: lens.sceneSlug, nodeId: lens.selectedId };
  }
  if (map !== null) return { surface: 'map', kind: map.kind, nodeId: map.nodeId, label: map.label };
  return null;
}

/** What the hand has selected RIGHT NOW - read fresh at send time. */
export function ambientSelection(): AmbientSelection {
  return composeAmbientSelection(currentEditing(), mapCitizen);
}

/** The open screen - the lens's editing truth; null when no page editor is open. */
export function ambientScreen(): { sceneSlug: string } | null {
  const lens = currentEditing();
  return lens !== null ? { sceneSlug: lens.sceneSlug } : null;
}

// Mirrors map selection to module truth while mounted; clears on unmount.
export function usePublishMapCitizenSelection(
  selected: ReadonlySet<string>,
  nodes: ReadonlyArray<{ id: string; kind: string; label: string }> | undefined,
): void {
  useEffect(() => {
    const one = selected.size === 1 ? [...selected][0]! : null;
    const n = one !== null ? nodes?.find((g) => g.id === one) ?? null : null;
    publishMapCitizenSelection(n != null ? { kind: n.kind, nodeId: n.id, label: n.label } : null);
  }, [selected, nodes]);
  useEffect(() => () => publishMapCitizenSelection(null), []);
}
