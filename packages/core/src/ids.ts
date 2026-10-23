/** Embedding dimension for capability vectors (vector(768) in the DB). */
export const EMBEDDING_DIM = 768;

export type OrgId = string & { readonly __brand: 'OrgId' };
export type AgentId = string & { readonly __brand: 'AgentId' };
export type JobId = string & { readonly __brand: 'JobId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type ThreadId = string & { readonly __brand: 'ThreadId' };
