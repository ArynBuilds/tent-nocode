import { z } from 'zod';

export const NODE_KINDS = ['agent', 'agent_version', 'job', 'run', 'decision', 'artifact', 'capability', 'external_source', 'document', 'entity', 'thread', 'fact', 'memory'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_RELATIONS = ['produced', 'invoked', 'evolved_from', 'decided_by', 'related_to', 'used_capability', 'touched_resource', 'escalated', 'mentions', 'describes', 'supersedes', 'derived_from', 'occurred_in', 'about', 'stated_in'] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export const nodeKindSchema = z.enum(NODE_KINDS);
export const edgeRelationSchema = z.enum(EDGE_RELATIONS);

export const edgeConfidenceSchema = z.enum(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
export type EdgeConfidence = z.infer<typeof edgeConfidenceSchema>;

/** A graph node as read back from the store. */
export interface GraphNode {
  id: string;
  key: string;
  kind: NodeKind;
  label: string;
  data: Record<string, unknown>;
  createdAt: Date;
}
