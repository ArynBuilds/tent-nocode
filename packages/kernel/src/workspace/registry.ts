import type postgres from 'postgres';
import type { z } from 'zod';
import type { MediaUrlMinter } from '../scenes/serve.js';
import type { OauthChannelDeps } from './integrations.js';

// THE ROUTER (tRPC's shape, no dependency): a typed record of procedures, each with a zod input list
// and a handler over one context; adapters (the host's POST /workspace/call, the desktop's IPC) call
// callProcedure by name. Every argument parses at the door; the client type is inferred, never written.

export interface WorkspaceIdentity {
  userId: string;
  orgId: string;
  role: 'owner';
  displayName: string;
  email: string;
}

/** What the host mounts once: the vault key, the oauth door, the media minter. */
export interface WorkspaceDeps {
  vaultMasterKey: Buffer | null;
  oauth: OauthChannelDeps | null;
  mintMediaUrls: MediaUrlMinter;
}

export interface WorkspaceContext {
  sql: postgres.Sql;
  identity: WorkspaceIdentity;
  deps: WorkspaceDeps;
}

export type ProcedureKind = 'read' | 'write';
export type InputList = readonly z.ZodTypeAny[];

/** The handler's parsed arguments: one per schema position. */
export type ArgsOut<I extends InputList> = { -readonly [K in keyof I]: I[K] extends z.ZodTypeAny ? z.output<I[K]> : never };

/** The caller's arguments: trailing positions whose schema admits undefined become optional. */
export type ArgsIn<I extends InputList> =
  I extends readonly [...infer H extends InputList, infer L extends z.ZodTypeAny]
    ? (undefined extends z.input<L> ? [...ArgsIn<H>, z.input<L>?] : { -readonly [K in keyof I]: I[K] extends z.ZodTypeAny ? z.input<I[K]> : never })
    : [];

export interface Procedure<K extends ProcedureKind, I extends InputList, O> {
  kind: K;
  input: I;
  handler: (ctx: WorkspaceContext, ...args: ArgsOut<I>) => Promise<O>;
}

export type AnyProcedure = Procedure<ProcedureKind, InputList, unknown>;
export type RouterRecord = Record<string, AnyProcedure>;

export function procedure<K extends ProcedureKind, const I extends InputList, O>(
  kind: K, input: I, handler: (ctx: WorkspaceContext, ...args: ArgsOut<I>) => Promise<O>,
): Procedure<K, I, O> {
  return { kind, input, handler };
}

/** A read answers raw on every mouth; a write answers through the { ok, data | error } envelope. */
export function read<const I extends InputList, O>(
  input: I, handler: (ctx: WorkspaceContext, ...args: ArgsOut<I>) => Promise<O>,
): Procedure<'read', I, O> {
  return procedure('read', input, handler);
}

export function write<const I extends InputList, O>(
  input: I, handler: (ctx: WorkspaceContext, ...args: ArgsOut<I>) => Promise<O>,
): Procedure<'write', I, O> {
  return procedure('write', input, handler);
}

/** One record of procedures; a duplicate name is a compile error on the object literal, never a runtime check. */
export function router<R extends RouterRecord>(record: R): R {
  return record;
}

export type MutationResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/** The client a mouth exposes: reads answer their output, writes answer the envelope. */
export type inferRouterClient<R extends RouterRecord> = {
  [K in keyof R]: R[K] extends Procedure<infer Kd, infer I, infer O>
    ? (...args: ArgsIn<I>) => Promise<Kd extends 'write' ? MutationResult<O> : O>
    : never;
};

export type inferProcedureOutput<R extends RouterRecord, K extends keyof R> =
  R[K] extends Procedure<ProcedureKind, InputList, infer O> ? O : never;

export type WorkspaceCallResult =
  | { ok: true; data: unknown; kind: ProcedureKind }
  | { ok: false; error: string; kind: ProcedureKind | null };

function issuePath(index: number, path: (string | number)[]): string {
  return path.length === 0 ? `args[${index}]` : `args[${index}].${path.join('.')}`;
}

/** Parses every argument in place, refusing with the first bad path named; extra arguments refuse too. */
export function parseProcedureArgs(proc: AnyProcedure, args: unknown[]): { ok: true; args: unknown[] } | { ok: false; error: string } {
  if (args.length > proc.input.length) {
    return { ok: false, error: `takes ${proc.input.length} argument(s), got ${args.length}` };
  }
  const parsed: unknown[] = [];
  for (let i = 0; i < proc.input.length; i++) {
    const schema = proc.input[i]!;
    // Electron IPC turns undefined into null inside the args list; a null in a position whose schema
    // accepts absence is treated as absent. A schema that deliberately accepts null still receives it.
    const value = args[i] === null && !schema.safeParse(null).success && schema.safeParse(undefined).success ? undefined : args[i];
    const res = schema.safeParse(value);
    if (!res.success) {
      const first = res.error.issues[0];
      const where = first === undefined ? `args[${i}]` : issuePath(i, first.path);
      return { ok: false, error: `${where}: ${first?.message ?? 'invalid'}` };
    }
    parsed.push(res.data);
  }
  return { ok: true, args: parsed };
}

/** The one dispatch: name -> procedure -> parsed arguments -> handler; every failure is one plain sentence. */
export async function callProcedure(
  record: RouterRecord, ctx: WorkspaceContext, name: string, args: unknown,
): Promise<WorkspaceCallResult> {
  const proc = Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
  if (proc === undefined) return { ok: false, error: `unknown workspace channel '${name}'`, kind: null };
  if (!Array.isArray(args)) return { ok: false, error: `'${name}': the arguments must be a list`, kind: proc.kind };
  const parsed = parseProcedureArgs(proc, args);
  if (!parsed.ok) return { ok: false, error: `'${name}' refused: ${parsed.error}`, kind: proc.kind };
  try {
    const data = await proc.handler(ctx, ...(parsed.args as ArgsOut<InputList>));
    return { ok: true, data, kind: proc.kind };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind: proc.kind };
  }
}

export function assertOwnOrg(identity: WorkspaceIdentity, orgId: unknown): void {
  if (orgId !== identity.orgId) throw new Error('not authorized for this org');
}

export function workspaceChannelNames(record: RouterRecord): string[] {
  return Object.keys(record).sort();
}
