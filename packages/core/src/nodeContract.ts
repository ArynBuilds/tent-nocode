// The node contract: one declaration row per citizen kind (words, face, ports, properties, verbs, inside). Pure data, zero React.

export const CITIZEN_KINDS = [
  'dataset', 'operation', 'output', 'scene', 'website', 'trigger', 'chain',
  'role', 'notes', 'project',
  'integration',
  'step',
] as const;
export type CitizenKind = (typeof CITIZEN_KINDS)[number];

/** The engine-owned face vocabulary NodeFace renders. */
export type FaceId = 'stat-card' | 'live-frame' | 'note-face';

/** Wire kinds by line style: solid = data, dashed = watch, dotted = permission, arrowed = flow. */
export type WireKindName = 'data' | 'watch' | 'permission' | 'flow';

/** Each legal pair compiles to one existing write; the pair compilers live in wiring.ts. */
export type WireWrite =
  | 'binding' | 'op-input' | 'chain' | 'trigger-source' | 'trigger-action'
  | 'grant' | 'nav'
  | 'write-back'           // Operation → Table: runs land as an upsert keyed by a column
  | 'result-binding'       // Result → App/Website: array/raster binding plus authored viewer
  | 'step-wire'            // step → step: the flow edge, explicit order
  | 'trigger-start-flow'   // Trigger → Step: the trigger starts the flow at that step
  | 'table-to-step'        // Table → Step: interpret-first - set the picker or bridge via Get rows
  | 'step-to-tool'         // Step → Tool: a fused run-tool step lands downstream
  | 'tool-to-step';        // Tool → Step: a fused run-tool step lands upstream

export interface PortRule { wire: WireKindName; write: WireWrite }

/** Bodies the one generic Inspector form knows how to render. */
export type PropertyBody =
  | 'detail-lines'      // the node's anatomy lines
  | 'scene-bindings'    // bindings with remove plus declared actions
  | 'notes'             // NotesDetail
  | 'publishing';       // the project's publish rows

/** Display tiers: essential renders by default, detail sits behind More, machine never renders to a human. */
export type PropertyTier = 'essential' | 'detail' | 'machine';
export interface PropertyDecl { body: PropertyBody; tier: PropertyTier }

/** Doors the ContractForm registry maps to desk IPC or navigation — names, never code. */
export type VerbDoor =
  | 'run-operation' | 'open-code' | 'open-rows' | 'open-notes'
  | 'edit-visuals' | 'revoke-chain'
  | 'try-endpoint'
  | 'toggle-step' | 'test-step';

export interface VerbDecl { label: string; door: VerbDoor }

/** Double-click never opens properties — it goes inside or does nothing. */
export type InsideDecl =
  | { descends: false }
  | { descends: true; canvas: 'notes' | 'rows' | 'editor' };

export interface NodeContract {
  words: { word: string; article: 'a' | 'an' };
  face: FaceId;
  ports: { out: Partial<Record<CitizenKind, PortRule>> };
  properties: PropertyDecl[];
  verbs: VerbDecl[];
  inside: InsideDecl;
}

const sceneLike = (word: 'App' | 'Website'): NodeContract => ({
  words: { word, article: word === 'App' ? 'an' : 'a' },
  face: 'live-frame',
  ports: {
    out: {
      operation: { wire: 'data', write: 'trigger-action' },
      scene: { wire: 'flow', write: 'nav' },
      website: { wire: 'flow', write: 'nav' },
    },
  },
  properties: [
    { body: 'scene-bindings', tier: 'essential' },
    { body: 'detail-lines', tier: 'machine' },
  ],
  verbs: [{ label: 'edit the visuals', door: 'edit-visuals' }],
  inside: { descends: true, canvas: 'editor' },
});

export const NODE_CONTRACTS: Record<CitizenKind, NodeContract> = {
  dataset: {
    words: { word: 'Table', article: 'a' },
    face: 'stat-card',
    ports: {
      out: {
        scene: { wire: 'data', write: 'binding' },
        website: { wire: 'data', write: 'binding' },
        operation: { wire: 'data', write: 'op-input' },
        trigger: { wire: 'watch', write: 'trigger-source' },
        step: { wire: 'data', write: 'table-to-step' },
      },
    },
    properties: [],
    verbs: [{ label: 'open the rows', door: 'open-rows' }],
    inside: { descends: true, canvas: 'rows' },
  },
  operation: {
    words: { word: 'Tool', article: 'a' },
    face: 'stat-card',
    ports: { out: {
      dataset: { wire: 'data', write: 'write-back' },
      step: { wire: 'flow', write: 'tool-to-step' },
    } },
    properties: [],
    verbs: [
      { label: 'Run', door: 'run-operation' },
      { label: 'open the code', door: 'open-code' },
    ],
    inside: { descends: false },
  },
  output: {
    words: { word: 'Result', article: 'a' },
    face: 'stat-card',
    ports: {
      out: {
        operation: { wire: 'data', write: 'chain' },
        trigger: { wire: 'watch', write: 'trigger-source' },
        scene: { wire: 'data', write: 'result-binding' },
        website: { wire: 'data', write: 'result-binding' },
      },
    },
    properties: [], // the config card is the Result's surface
    verbs: [],
    inside: { descends: false },
  },
  scene: sceneLike('App'),
  website: sceneLike('Website'),
  trigger: {
    words: { word: 'Trigger', article: 'a' },
    face: 'stat-card',
    // A trigger's action may be a Tool run or a Connection call.
    ports: { out: {
      operation: { wire: 'watch', write: 'trigger-action' },
      integration: { wire: 'watch', write: 'trigger-action' },
      step: { wire: 'watch', write: 'trigger-start-flow' },
    } },
    properties: [],
    verbs: [],
    inside: { descends: false },
  },
  chain: {
    words: { word: 'Auto-update', article: 'an' },
    face: 'stat-card',
    ports: { out: {} },
    properties: [], // the config card is the surface; the revoke verb stands
    verbs: [{ label: 'revoke', door: 'revoke-chain' }],
    inside: { descends: false },
  },
  role: {
    words: { word: 'Assistant', article: 'an' },
    face: 'stat-card',
    // The permission wire is the grant; deleting it revokes.
    ports: { out: { dataset: { wire: 'permission', write: 'grant' } } },
    properties: [],
    // The instructions surface died with the roles library; the charter updates with the app.
    verbs: [],
    inside: { descends: false },
  },
  notes: {
    words: { word: 'Notes', article: 'a' },
    face: 'note-face',
    ports: { out: {} },
    properties: [{ body: 'notes', tier: 'essential' }],
    verbs: [],
    inside: { descends: true, canvas: 'notes' },
  },
  project: {
    words: { word: 'Project', article: 'a' },
    face: 'stat-card',
    ports: { out: {} },
    properties: [
      { body: 'publishing', tier: 'essential' },
      { body: 'detail-lines', tier: 'detail' },
    ],
    verbs: [],
    inside: { descends: false },
  },
  // The Connection citizen: a connection row placed unconnected, configured via the config card.
  integration: {
    words: { word: 'Connection', article: 'a' },
    face: 'stat-card',
    ports: { out: {} },
    properties: [],
    verbs: [{ label: 'Try it', door: 'try-endpoint' }],
    inside: { descends: false },
  },
  step: {
    words: { word: 'Step', article: 'a' },
    face: 'stat-card',
    ports: { out: {
      step: { wire: 'flow', write: 'step-wire' },
      operation: { wire: 'flow', write: 'step-to-tool' },
    } },
    properties: [], // the config card renders the def's params
    verbs: [{ label: 'Test', door: 'test-step' }, { label: 'Switch off', door: 'toggle-step' }],
    inside: { descends: false },
  },
};

export function citizenWord(kind: string): string {
  return (NODE_CONTRACTS as Record<string, NodeContract>)[kind]?.words.word ?? kind;
}

/** "a table" / "an app" — the phrase refusal sentences use. */
export function citizenPhrase(kind: string): string {
  const c = (NODE_CONTRACTS as Record<string, NodeContract>)[kind];
  return c === undefined ? kind : `${c.words.article} ${c.words.word.toLowerCase()}`;
}

/** The one wire-legality source: checkWire consults this; the browser filters by it. */
export function portRule(source: string, target: string): PortRule | null {
  return (NODE_CONTRACTS as Record<string, NodeContract>)[source]?.ports.out[target as CitizenKind] ?? null;
}

/** The kinds a wire may legally reach from `source`. */
export function legalTargets(source: string): CitizenKind[] {
  const c = (NODE_CONTRACTS as Record<string, NodeContract>)[source];
  return c === undefined ? [] : (Object.keys(c.ports.out) as CitizenKind[]);
}

// ---- Element ports: the wire law for scene elements, by element class -------------------

export type ElementWrite =
  | 'nav-item'          // add {label, ref} + set_ref on the element's nav node
  | 'action-run'        // declared action rule: run_operation
  | 'action-append'     // declared action rule: append_row
  | 'action-propose'    // declared action rule: propose_work
  | 'action-call'       // declared action rule: call_integration
  | 'element-binding'   // scene-level binding + the element's own binding param when it has one
  | 'button-nav'        // set_ref goto scene:<slug> on the button itself
  | 'param-feed'        // an on-screen input feeds a rule's field
  | 'action-start-flow' // declared action rule: start_flow
  | 'row-nav';          // a rowActions {goto, keyColumn} entry - clicking a row opens the view carrying that row's key

export interface ElementPortRule { wire: WireKindName; write: ElementWrite; word: string }

export const ELEMENT_PORTS: Record<'nav' | 'action' | 'display', Partial<Record<CitizenKind, ElementPortRule>>> = {
  nav: {
    scene: { wire: 'flow', write: 'nav-item', word: 'Go to a view' },
    website: { wire: 'flow', write: 'nav-item', word: 'Go to a view' },
  },
  action: {
    operation: { wire: 'data', write: 'action-run', word: 'Run a tool' },
    dataset: { wire: 'data', write: 'action-append', word: 'Save to a table' },
    role: { wire: 'data', write: 'action-propose', word: 'Ask the assistant' },
    integration: { wire: 'data', write: 'action-call', word: 'Send through a connection' },
    scene: { wire: 'flow', write: 'button-nav', word: 'Go to a view' },
    website: { wire: 'flow', write: 'button-nav', word: 'Go to a view' },
    step: { wire: 'data', write: 'action-start-flow', word: 'Start a flow' },
  },
  display: {
    dataset: { wire: 'data', write: 'element-binding', word: 'Show a table' },
    integration: { wire: 'data', write: 'param-feed', word: 'Feed a connection' },
    scene: { wire: 'flow', write: 'row-nav', word: 'Open a view per row' },
    website: { wire: 'flow', write: 'row-nav', word: 'Open a view per row' },
  },
};

export function elementPortRule(cls: string, target: string): ElementPortRule | null {
  return (ELEMENT_PORTS as Record<string, Partial<Record<string, ElementPortRule>>>)[cls]?.[target] ?? null;
}

/** The kinds an element wire may legally reach (the browser's element filter). */
export function elementLegalTargets(cls: string): CitizenKind[] {
  const row = (ELEMENT_PORTS as Record<string, Partial<Record<CitizenKind, ElementPortRule>>>)[cls];
  return row === undefined ? [] : (Object.keys(row) as CitizenKind[]);
}

// ---- Edge words -----------------------------------------------------------------------

export const EDGE_VERB_SENTENCES: Record<string, string> = {
  feeds: 'feeds', produces: 'produces', shows: 'shows on',
  watches: 'watches', runs: 'runs', updates: 'keeps updated', built: 'built',
  'may-edit': 'may edit', nav: 'leads to',
};

export const EDGE_VERB_WIRE_KINDS: Record<string, WireKindName> = {
  feeds: 'data', produces: 'data', shows: 'data', built: 'data',
  watches: 'watch', runs: 'watch', updates: 'watch',
  'may-edit': 'permission', nav: 'flow',
};

// ---- The scope wire's grant grammar ---------------------------------------------------
// The Assistant → Table wire is a standing grant scoped to the rows construct on that table.

export function datasetGrantPatterns(dataset: string): string[] {
  return [`rows(${dataset})`];
}

/** Action pattern → the dataset it scopes, or null when it is not a scope-wire grant. */
export function parseDatasetGrant(action: string): string | null {
  const m = /^rows\((.+)\)$/.exec(action);
  return m?.[1] ?? null;
}
