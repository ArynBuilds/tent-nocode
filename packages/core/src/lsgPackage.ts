import { z } from 'zod';
import { SCENE_SCHEMA_VERSION, sceneDocumentSchema } from './scene.js';

// THE .TPROJECT FORMAT, tproject@2 (Phase 12, rulings 14 and 16): a package IS the project document -
// the model's collections as typed entries (Webstudio's fragment shape), one manifest, one closure,
// one content hash (pacote's integrity shape). No engine pin, no chat wiring, no component definitions:
// the five primitives are the contract, not a payload. The file keeps its lsgPackage name; the format
// word is tproject@2 and an older format refuses by name.

export const LSG_PACKAGE_FORMAT = 'tproject@2';

const entryName = z.string().min(1).max(200);
const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// Closure roles: root = a selected root; hard = must land with the package; soft = a descriptor the importer re-binds.
const entryBase = {
  name: entryName,
  role: z.enum(['root', 'hard', 'soft']),
  contentHash: z.string().length(64),
};

const rowSchema = z.record(z.string().min(1).max(64), z.enum(['string', 'number', 'boolean']));

export const lsgEntrySchema = z.discriminatedUnion('kind', [
  // The project itself: its name, kind and theme; import finds or births the project by this name.
  z.object({
    ...entryBase, kind: z.literal('project'),
    projectName: z.string().min(1).max(120),
    projectKind: z.enum(['app', 'website']).optional(),
    theme: z.record(z.unknown()).optional(),
  }).strict(),
  // A table: its schema (and grain, key columns) plus optional rows inline or as hash-verified chunks in the data lane.
  z.object({
    ...entryBase, kind: z.literal('table'),
    rowSchema,
    keyColumns: z.array(z.string().min(1).max(64)).max(8).optional(),
    grain: z.enum(['own', 'shared', 'submitted', 'app']).optional(),
    rows: z.array(z.record(z.unknown())).max(100_000).optional(),
    rowChunks: z.array(z.object({
      sha256: z.string().length(64), rows: z.number().int().min(1), bytes: z.number().int().min(1),
    }).strict()).min(1).optional(),
  }).strict(),
  // A screen: the primitives document as it is, its query/asset/clock bindings and its declared actions.
  z.object({
    ...entryBase, kind: z.literal('screen'),
    title: z.string().min(1).max(200),
    purpose: z.string().max(2000).optional(),
    document: sceneDocumentSchema,
    bindings: z.array(z.unknown()).max(12).optional(),
    actions: z.array(z.unknown()).max(8).optional(),
    targetScreen: z.object({ w: z.number(), h: z.number() }).passthrough().optional(),
  }).strict(),
  // A library item (name@version): the saved composition of the five with its exposed children and variants.
  z.object({ ...entryBase, kind: z.literal('library-item'), item: z.record(z.unknown()) }).strict(),
  // A flow rides as its doc alone; connection values are stripped at export and again at import.
  z.object({ ...entryBase, kind: z.literal('flow'), doc: z.record(z.unknown()) }).strict(),
  // A trigger rides soft beside its flow; webhook endpoint tokens never travel and imports land disabled.
  z.object({
    ...entryBase, kind: z.literal('trigger'),
    triggerKind: z.string().min(1).max(60),
    spec: z.record(z.unknown()), action: z.record(z.unknown()),
  }).strict(),
  // A placed service: the integration and its label, never a secret or a setting; the importer connects with its own key.
  z.object({
    ...entryBase, kind: z.literal('service'),
    integration: kebab,
    version: z.number().int().min(1),
    label: z.string().min(1).max(200),
    scope: z.enum(['builder', 'app-user']).optional(),
  }).strict(),
  // An operation (name@version): registration plus sealed source; its model asset rides as a hash and a license.
  z.object({
    ...entryBase, kind: z.literal('operation'),
    registration: z.record(z.unknown()), source: z.string().max(1_000_000),
    model: z.object({ sha256: z.string().length(64), license: z.string().min(1).max(200) }).strict().optional(),
  }).strict(),
  // Project notes ride soft; import lands them through the append-only notes store.
  z.object({
    ...entryBase, kind: z.literal('notes'), projectName: z.string().min(1).max(120),
    notes: z.array(z.object({
      body: z.string().min(8).max(2000), author: z.string().min(1).max(80), createdAt: z.string().min(1),
    }).strict()).min(1).max(200),
  }).strict(),
]);
export type LsgEntry = z.infer<typeof lsgEntrySchema>;
export type LsgEntryKind = LsgEntry['kind'];
/** An entry before its content hash is stamped (the omit distributes over the union). */
export type LsgEntryDraft = LsgEntry extends infer E ? E extends { contentHash: string } ? Omit<E, 'contentHash'> : never : never;

export const lsgManifestSchema = z
  .object({
    format: z.literal(LSG_PACKAGE_FORMAT),
    schemaVersion: z.number().int().min(1).max(SCENE_SCHEMA_VERSION),
    license: z.string().min(1).max(500),
    provenance: z.object({ org: z.string().min(1), appVersion: z.string().min(1), exportedAt: z.string().min(1) }).strict(),
    // App identity: keys the import's find-or-birth landing and the born project's kind.
    app: z.object({ title: z.string().min(1).max(200), kind: z.enum(['app', 'website']).optional() }).strict().optional(),
    // The assistant declaration: identity as data, never a genome or a credential.
    assistant: z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }).strict().optional(),
    closure: z.array(z.object({ kind: z.string().min(1), name: entryName, role: z.enum(['root', 'hard', 'soft']), contentHash: z.string().length(64) }).strict()).min(1),
  })
  .strict();
export type LsgManifest = z.infer<typeof lsgManifestSchema>;

export const lsgPackageSchema = z
  .object({
    manifest: lsgManifestSchema,
    entries: z.array(lsgEntrySchema).min(1),
    /** sha256 over the canonical {manifest, entries}; the one content hash verify checks. */
    packageHash: z.string().length(64),
    // Chunked table rows, keyed by chunk content hash; packageHash covers {manifest, entries} only.
    data: z.record(z.array(z.record(z.unknown()))).optional(),
    // Optional canvas arrangement (positions, folds); never gates verification.
    arrangement: z.record(z.unknown()).optional(),
  })
  .strict();
export type LsgPackage = z.infer<typeof lsgPackageSchema>;
