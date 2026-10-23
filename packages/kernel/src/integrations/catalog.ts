// The integration catalog: one data file per integration in defs/, this module the one reader; a def names which vault secret it needs, never holds one.
import { z } from 'zod';
import { canonicalContentHash } from '../scenes/packageVerify.js';
import { INTEGRATION_DEFS } from './defs/index.js';

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
const SLOT_NAME_RE = /^[a-z][a-z0-9_]*$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** The three scalar types dataset rows accept. */
const scalarTypeSchema = z.enum(['string', 'number', 'boolean']);

const paramSchema = z
  .object({
    type: scalarTypeSchema,
    required: z.boolean().optional(),
    /** Closed choice list; a provided value outside it refuses. */
    choices: z.array(z.string().min(1)).max(50).optional(),
    help: z.string().max(200).optional(),
    /** The exact on-wire field name when the service's casing differs from the param name. */
    wire: z.string().min(1).max(60).optional(),
    /** A dot path into the json body; numeric segments mint arrays; wins over `wire` for json bodies. */
    at: z.string().min(1).max(120).optional(),
  })
  .strict();

/** Constant request headers, lowercase names; the credential header stays auth's alone. */
const headersSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/).max(60), z.string().min(1).max(200));

const endpointSchema = z
  .object({
    id: z.string().regex(KEBAB_RE).max(60),
    /** Plain words, never a method or path. */
    displayName: z.string().min(3).max(80),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** Path template with {slot} names; every slot must be a declared param. */
    path: z.string().min(1).max(300),
    /** Capability class; drives default consent rules. */
    class: z.enum(['read', 'write', 'send']),
    params: z.record(z.string().regex(SLOT_NAME_RE).max(50), paramSchema).default({}),
    /** Where non-slot params ride: json body (default for POST/PUT/PATCH), form body, or the query string. */
    body: z.enum(['json', 'form', 'query']).optional(),
    /** When the def declares several hosts, the one this endpoint calls (defaults to hosts[0]). */
    host: z.string().optional(),
    /** Per-endpoint constant headers, merged over def-level; auth still wins. */
    headers: headersSchema.optional(),
    /** Builder-facing depth beyond displayName - catalog-served, never on cards. */
    hint: z.string().min(10).max(400).optional(),
    /** Constant json-body fields: dot path to literal, merged before params (params win). */
    bodyConstants: z.record(z.string().min(1).max(200), z.string().max(4000)).optional(),
    /** Declared response projections: a dot path into the response JSON, or a response header by name. */
    picks: z.array(z.union([
      z.object({ field: z.string().regex(SLOT_NAME_RE).max(50), from: z.string().min(1).max(200) }).strict(),
      z.object({ field: z.string().regex(SLOT_NAME_RE).max(50), fromHeader: z.string().min(1).max(80) }).strict(),
    ])).max(40).optional(),
  })
  .strict();

const innerTableSchema = z
  .object({
    name: z.string().regex(KEBAB_RE).max(60),
    displayName: z.string().min(2).max(60),
    rowSchema: z.record(z.string().regex(KEBAB_RE).max(50), scalarTypeSchema),
    /** Integration-fed tables default to the app grain. */
    grain: z.enum(['app', 'own', 'shared', 'submitted']).default('app'),
    /** A dot path to an array in the call result: one row lands per element; absent = one row per call. */
    fromArray: z.string().min(1).max(200).optional(),
  })
  .strict();

const innerWatcherSchema = z
  .object({
    id: z.string().regex(KEBAB_RE).max(60),
    displayName: z.string().min(2).max(60),
    /** The service event this watcher fires on. */
    event: z.string().min(1).max(120),
  })
  .strict();

// Def-declared triggers: webhook rides webhook_in, poll rides rows_changed over the synced table; excluded from the spec hash.
const triggerDeclSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('webhook'),
    id: z.string().regex(KEBAB_RE).max(60),
    displayName: z.string().min(3).max(80),
    /** The dot path to the event name in the vendor's webhook body. */
    eventPath: z.string().min(1).max(120),
    /** The vendor event names that fire this trigger. */
    events: z.array(z.string().min(1).max(120)).min(1).max(24),
  }).strict(),
  z.object({
    kind: z.literal('poll'),
    id: z.string().regex(KEBAB_RE).max(60),
    displayName: z.string().min(3).max(80),
    /** The declared inner table the mirror feeds; rows_changed watches it. */
    table: z.string().regex(KEBAB_RE).max(60),
  }).strict(),
]);

const settingSchema = z
  .object({
    id: z.string().regex(SLOT_NAME_RE).max(50),
    label: z.string().min(2).max(60),
    kind: z.enum(['text', 'number', 'boolean', 'enum', 'template', 'channel-pick']),
    choices: z.array(z.string().min(1)).max(50).optional(),
    help: z.string().max(200).optional(),
  })
  .strict();

const fixtureSchema = z
  .object({
    endpoint: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    status: z.number().int().min(100).max(599).default(200),
    response: z.unknown(),
  })
  .strict();

export const integrationDefSchema = z
  .object({
    name: z.string().regex(KEBAB_RE).max(60),
    version: z.number().int().min(1),
    displayName: z.string().min(2).max(60),
    /** One plain sentence of what connecting enables. */
    blurb: z.string().min(10).max(200),
    category: z.string().regex(KEBAB_RE).max(40),
    /** Which project kinds may offer this entry. */
    surfaces: z.enum(['app', 'website', 'both']),
    /** An upcoming entry lists and places, but Connect refuses until it flips ready; excluded from the spec hash. */
    availability: z.enum(['ready', 'upcoming']).default('ready'),
    /** Whose account the connection binds: the builder's or each app user's. */
    scope: z.enum(['builder', 'app-user', 'both']).default('builder'),
    /** Closed https host list, an owner-pinned host supplied at Connect, or a host template with one subdomain slot filled at Connect. */
    hosts: z.union([
      z.array(z.string().min(1)).min(1).max(6),
      z.object({ ownerPinned: z.literal(true) }).strict(),
      z.object({
        template: z.string().min(12).max(120),
        slot: z.string().regex(SLOT_NAME_RE).max(20),
      }).strict().refine(
        (h) => new RegExp(`^https://\\{${h.slot}\\}(\\.[a-z0-9-]+)+$`).test(h.template),
        { message: 'the host template is https://{slot}.rest-of-the-domain' },
      ),
    ]),
    /** Def-level constant headers; every endpoint inherits. */
    headers: headersSchema.optional(),
    auth: z.union([
      z.object({ kind: z.literal('none') }).strict(),
      z
        .object({
          kind: z.enum(['bearer', 'header', 'basic']),
          /** The request header the credential rides (bearer defaults to Authorization). */
          header: z.string().max(60).optional(),
          scheme: z.string().max(20).optional(),
          /** The vault secret name; the def never holds a value. */
          secretName: z.string().regex(SECRET_NAME_RE).max(60),
          /** Plain words: where the owner finds this key on the service's site. */
          tokenHelp: z.string().min(10).max(300),
        })
        .strict(),
      // Query-carried key: the executor injects the vault secret as this query param at send time.
      z
        .object({
          kind: z.literal('query'),
          param: z.string().regex(SLOT_NAME_RE).max(50),
          secretName: z.string().regex(SECRET_NAME_RE).max(60),
          tokenHelp: z.string().min(10).max(300),
        })
        .strict(),
      // Path-carried secret: a path prefix with one {secret} slot only the executor fills at send time.
      z
        .object({
          kind: z.literal('path'),
          template: z.string().min(9).max(120).refine(
            (t) => t.startsWith('/') && (t.match(/\{secret\}/g) ?? []).length === 1 && !/\{(?!secret\})/.test(t.replace('{secret}', '')),
            { message: 'the path template starts with / and carries exactly one {secret} slot' },
          ),
          secretName: z.string().regex(SECRET_NAME_RE).max(60),
          tokenHelp: z.string().min(10).max(300),
        })
        .strict(),
      // Body-carried secret: the executor deep-sets the vault secret at the declared dot path in the json body at send time.
      z
        .object({
          kind: z.literal('body'),
          at: z.string().min(1).max(120),
          secretName: z.string().regex(SECRET_NAME_RE).max(60),
          tokenHelp: z.string().min(10).max(300),
        })
        .strict(),
      // OAuth: one platform app per service; tokens seal into the vault per connection and refresh inside the executor alone.
      z
        .object({
          kind: z.literal('oauth'),
          authUrl: z.string().min(12).max(300),
          tokenUrl: z.string().min(12).max(300),
          /** Empty when the vendor has no scopes; the authorize URL then omits the param. */
          scopes: z.array(z.string().min(1).max(120)).max(20),
          /** TENT_OAUTH_<clientEnv>_ID/_SECRET hold the app's credentials in the host's env. */
          clientEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(40),
          tokenHelp: z.string().min(10).max(300),
        })
        .strict(),
    ]),
    endpoints: z.array(endpointSchema).min(1).max(60),
    /** Inner tables and watchers; individually undeletable, delete takes the whole node. */
    inside: z
      .object({ tables: z.array(innerTableSchema).max(12).default([]), watchers: z.array(innerWatcherSchema).max(12).default([]) })
      .strict()
      .default({ tables: [], watchers: [] }),
    /** Everything that needs setting up lives here: templates, channel picks, pull params. */
    settings: z.array(settingSchema).max(24).default([]),
    /** Mirror sync: the named read endpoint fires on a cadence per active connection; everyMinutes clamps at 15 kernel-side. */
    sync: z.object({
      endpoint: z.string().regex(KEBAB_RE),
      everyMinutes: z.number().int().min(15).max(1440),
    }).strict().optional(),
    /** Import door: a one-time paged pull landing as an ordinary table, upsert-by-key; fromArray '.' means the body is the array. */
    importDoor: z.object({
      endpoint: z.string().regex(KEBAB_RE),
      fromArray: z.string().min(1).max(200),
      elementAt: z.string().min(1).max(120).optional(),
      keyColumn: z.string().min(1).max(80),
      page: z.union([
        z.object({ kind: z.literal('cursor'), pick: z.string().min(1).max(200), param: z.string().regex(SLOT_NAME_RE) }).strict(),
        z.object({ kind: z.literal('offset'), param: z.string().regex(SLOT_NAME_RE), size: z.number().int().min(1).max(1000) }).strict(),
      ]).optional(),
    }).strict().optional(),
    /** The service's trigger rows; not hash-covered. */
    triggers: z.array(triggerDeclSchema).max(12).default([]),
    /** Recorded request/response pairs the gate replays offline. */
    fixtures: z.array(fixtureSchema).max(40).default([]),
  })
  .strict();

export type IntegrationDef = z.infer<typeof integrationDefSchema>;
/** The authoring shape (defaults optional); the catalog parses to the full IntegrationDef at module init. */
export type IntegrationDefInput = z.input<typeof integrationDefSchema>;
export type IntegrationEndpointDef = z.infer<typeof endpointSchema>;
export type IntegrationParamDef = z.infer<typeof paramSchema>;

/** The spec hash pins consented reach; a drifted def refuses to execute against an old snapshot. */
export function integrationSpecHash(def: IntegrationDef): string {
  // Fixtures, availability, and triggers add no outbound reach, so they are excluded.
  const { fixtures: _fixtures, availability: _availability, triggers: _triggers, ...reach } = def;
  return canonicalContentHash(reach);
}

/** Slot names appearing in a path template ("/v1/items/{id}" -> ["id"]). */
export function pathSlots(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(/\{([^{}]*)\}/g)) out.push(m[1] ?? '');
  return out;
}

const catalog = new Map<string, IntegrationDef>();
const latest = new Map<string, IntegrationDef>();
for (const raw of INTEGRATION_DEFS) {
  const def = integrationDefSchema.parse(raw);
  const key = `${def.name}@${def.version}`;
  if (catalog.has(key)) throw new Error(`integration catalog: duplicate entry ${key}`);
  catalog.set(key, Object.freeze(def));
  const head = latest.get(def.name);
  if (!head || def.version > head.version) latest.set(def.name, def);
}

/** Every catalog entry (all versions), stable order. */
export function listIntegrationDefs(): IntegrationDef[] {
  return [...catalog.values()];
}

/** Resolve name@version, or the latest version when version is omitted. Null when absent - the caller owns the refusal sentence. */
export function resolveIntegrationDef(name: string, version?: number): IntegrationDef | null {
  if (version !== undefined) return catalog.get(`${name}@${version}`) ?? null;
  return latest.get(name) ?? null;
}
