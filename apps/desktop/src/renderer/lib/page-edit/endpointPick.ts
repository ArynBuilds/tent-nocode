import { desk } from '../desk.js';
import { store } from '../canvas/store.js';

// The endpoint pick over the five: a Connection's doors resolve from the catalog in plain words; zero doors
// refuse with one sentence, one door answers straight, several ask through the node browser one beat.
// (The parameter feed died with the call_integration scene rule in Phase 12 wave C: a connection runs
// inside a flow step now, and a field feeds the step's params through the flow.)

export interface ConnectionDoor {
  id: string;
  word: string;
  klass: 'read' | 'write' | 'send';
  params: Array<{ name: string; type: 'string' | 'number' | 'boolean'; required: boolean }>;
}

export interface ResolvedConnection { connectionId: string; label: string; integration: string; doors: ConnectionDoor[] }

export const NO_DOORS_SENTENCE = 'that connection has no doors yet';

export async function resolveConnectionDoors(orgId: string, projectId: string | null, connectionId: string): Promise<ResolvedConnection | null> {
  const connections = await desk.integrationsList(orgId, projectId ?? undefined).catch(() => []);
  const conn = connections.find((c) => c.id === connectionId);
  if (conn === undefined) return null;
  const catalog = await desk.integrationsCatalog().catch(() => []);
  const entry = catalog.find((e) => e.name === conn.integration && e.version === conn.version);
  if (entry === undefined) return null;
  return {
    connectionId, label: conn.label, integration: conn.integration,
    doors: entry.endpoints.map((e) => ({ id: e.id, word: e.displayName, klass: e.class, params: e.params.map((p) => ({ name: p.name, type: p.type, required: p.required })) })),
  };
}

export function pickConnectionDoor(input: {
  resolved: ResolvedConnection;
  projectId: string | null;
  say: (sentence: string) => void;
  onDoor: (endpoint: string) => void;
}): void {
  const { doors } = input.resolved;
  if (doors.length === 0) { input.say(NO_DOORS_SENTENCE); return; }
  const only = doors[0];
  if (doors.length === 1 && only !== undefined) { input.onDoor(only.id); return; }
  const opened = store.openBrowser({
    mode: 'wire', headline: 'Through which door?', doors, projectId: input.projectId,
    onPick: (choice) => { if (choice.pick === 'door') input.onDoor(choice.id); },
  });
  if (!opened) input.say('open the side panel to pick a door');
}

/** The one-beat column pick: one answers straight; several ask through the browser. */
export function pickColumn(input: {
  headline: string;
  columns: Array<{ key: string; display: string }>;
  projectId: string | null;
  say: (sentence: string) => void;
  onColumn: (key: string) => void;
}): void {
  const only = input.columns[0];
  if (only === undefined) { input.say('that table has no columns yet'); return; }
  if (input.columns.length === 1) { input.onColumn(only.key); return; }
  const opened = store.openBrowser({
    mode: 'wire', headline: input.headline,
    doors: input.columns.map((c) => ({ id: c.key, word: c.display, klass: 'read' as const })),
    projectId: input.projectId,
    onPick: (choice) => { if (choice.pick === 'door') input.onColumn(choice.id); },
  });
  if (!opened) input.say('open the side panel to pick a column');
}
