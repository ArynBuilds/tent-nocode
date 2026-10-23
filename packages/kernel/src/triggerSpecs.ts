import { z } from 'zod';
import { KEBAB_RE } from '@tent-nocode/core';

// The trigger vocabulary: the closed kind specs and the closed action grammar.

export const TRIGGER_SPECS = {
  dataset_threshold: z.object({
    dataset: z.string().regex(KEBAB_RE, 'kebab-case dataset name'),
    column: z.string().min(1),
    op: z.enum(['>', '>=', '<', '<=', '==']),
    value: z.number(),
  }).strict(),
  output_registered: z.object({
    name: z.string().regex(KEBAB_RE).optional(),
    kind: z.enum(['array', 'raster']).optional(),
  }).strict(),
  file_landed: z.object({
    folder: z.string().min(1),
    glob: z.string().min(1),
  }).strict(),
  // Fires when a verified event lands on the named endpoint.
  webhook_in: z.object({
    /** The endpoint's token (the URL tail). */
    endpoint: z.string().min(8),
    /** Optional filter: fire only when the payload's value at `path` is one of `oneOf`. */
    event: z.object({
      path: z.string().min(1).max(120),
      oneOf: z.array(z.string().min(1).max(120)).min(1).max(24),
    }).strict().optional(),
  }).strict(),
  // Fires when a table gains a row.
  rows_changed: z.object({
    dataset: z.string().regex(KEBAB_RE),
    /** Optional predicate: fire only when the fresh row's `column` equals `equals`. */
    where: z.object({
      column: z.string().min(1).max(120),
      equals: z.string().min(1).max(120),
    }).strict().optional(),
  }).strict(),
  // The three clock kinds, all firing off the one sweep clock.
  schedule: z.object({
    /** Daily at HH:MM, UTC. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).strict(),
  cron: z.object({
    /** 5-field cron (minute hour dom month dow); minute resolution. */
    expr: z.string().min(9).max(60),
  }).strict(),
  interval: z.object({
    minutes: z.number().int().min(1).max(1440),
  }).strict(),
} as const;

export type TriggerKind = keyof typeof TRIGGER_SPECS;

export const TRIGGER_ACTIONS = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_operation'),
    operation: z.string().regex(KEBAB_RE),
    inputs: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  z.object({
    type: z.literal('propose_work'),
    goal: z.string().min(1),
    brief: z.string().min(1),
    /** The role that owns the fired work. */
    role: z.string().min(2).max(40).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
    /** The standing thread the proposal raises into; its mode governs the card. */
    threadId: z.string().uuid(),
  }).strict(),
  // Fires a connected integration endpoint; the creation approval is the standing scoped grant.
  z.object({
    type: z.literal('call_integration'),
    connection: z.string().uuid(),
    endpoint: z.string().regex(KEBAB_RE),
    /** Static values only — an unattended fire has no human to ask. */
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }).strict(),
  // Starts a flow at its entry step; the fire payload becomes the run's trigger item.
  z.object({
    type: z.literal('start_flow'),
    /** The flow's name in the trigger's project ('main' = the working doc). */
    flow: z.string().regex(KEBAB_RE).default('main'),
    /** The entry step this trigger feeds. */
    entry: z.string().min(1).max(60),
  }).strict(),
]);
export type TriggerAction = z.infer<typeof TRIGGER_ACTIONS>;
