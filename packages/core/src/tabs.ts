import { z } from 'zod';

// Tab manifest schema: bindings are host-executed queries; generated code never composes a query or holds a credential.

export const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Default byte ceiling for authored tab code only; engines, media, and channel data do not count.
export const TAB_BUNDLE_MAX_BYTES = 2048 * 1024;

// Engine refs are always version-pinned (`canvas2d@1`); "latest" never resolves.
export const ENGINE_REF_RE = /^[a-z0-9-]+@\d+$/;

export const tabBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string().regex(KEBAB_RE), kind: z.literal('events'),
    filter: z.object({
      type: z.string().min(1).nullable().default(null),
      limit: z.number().int().min(1).max(500).default(100),
    }).default({}),
  }).strict(),
  z.object({
    name: z.string().regex(KEBAB_RE), kind: z.literal('overview'),
    source: z.enum(['jobs', 'runs', 'agents']),
    limit: z.number().int().min(1).max(200).default(50),
  }).strict(),
  z.object({
    name: z.string().regex(KEBAB_RE), kind: z.literal('dataset'),
    dataset: z.string().regex(KEBAB_RE),
    // Declared row shape (field name → primitive type), verified on every appended row.
    rowSchema: z.record(z.enum(['string', 'number', 'boolean'])),
    limit: z.number().int().min(1).max(1000).default(200),
  }).strict(),
  // Write binding: an in-tab action may append rows only to this dataset, validated against this rowSchema.
  z.object({
    name: z.string().regex(KEBAB_RE), kind: z.literal('dataset_write'),
    dataset: z.string().regex(KEBAB_RE),
    rowSchema: z.record(z.enum(['string', 'number', 'boolean'])),
  }).strict(),
  // Media binding: granted-folder files stream into the tab read-only, host-fed; the tab never touches the filesystem.
  z.object({
    name: z.string().regex(KEBAB_RE), kind: z.literal('media'),
    folder: z.string().min(1),
    select: z.string().min(1).default('**/*'),
  }).strict(),
]);
export type TabBinding = z.infer<typeof tabBindingSchema>;

export const tabManifestSchema = z.object({
  title: z.string().min(1),
  bindings: z.array(tabBindingSchema).max(12),
  // Engines the host injects at mount; the kernel registry validates them at publish.
  engines: z.array(z.string().regex(ENGINE_REF_RE)).max(4).default([]),
}).strict();
export type TabManifest = z.infer<typeof tabManifestSchema>;
