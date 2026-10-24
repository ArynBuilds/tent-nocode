import postgres from 'postgres';
import { flowEnvelopeSchema, sceneBindingsSchema, tablesReadBy, type FlowEffect, type SceneBinding } from '@nodeloom/core';
import { executeSceneBinding } from './scenes/bindings.js';

// THE PUSH (Phase 12, ruling 8): the LISTEN watcher parses desk_live pointers; the delta computer knows which
// screens' queries read which tables and, on a change, executes the affected bindings once and pushes
// {binding, rows} to whoever watches (A2UI's updateDataModel: the server pushes the value at the path;
// json-render's state store: notify the changed paths alone). A settled scene-action run pushes its effects
// the same way. One computer, two mouths: the workspace hub (every active screen of an org) and the room's
// live route (each page's screen under its own user).

const LIVE_CHANNEL = 'desk_live';

/** A desk_live pointer: the table set is the trigger's, never a list in code. */
export type LiveTable = string;

export interface LiveEvent {
  table: LiveTable;
  op: 'INSERT' | 'UPDATE';
  orgId: string | null;
  id: string;
}

/** One binding's fresh rows for one screen. */
export interface BindingDelta {
  kind: 'binding';
  orgId: string;
  sceneId: string;
  scene: string;
  binding: string;
  rows: Record<string, unknown>[];
  text: string | null;
  error: string | null;
  tick?: number;
}

/** A scene-action run settled after its answer went out; the effects the answer could not carry. */
export interface EffectsPush {
  kind: 'effects';
  orgId: string;
  scene: string;
  execution: string;
  status: 'succeeded' | 'failed';
  effects: FlowEffect[];
  error?: string;
}

export type LivePush = LiveEvent | BindingDelta | EffectsPush;

export function isPointerEvent(m: LivePush): m is LiveEvent {
  return !('kind' in m);
}

const VALID_OPS: readonly LiveEvent['op'][] = ['INSERT', 'UPDATE'];

interface RawNotifyPayload {
  table?: unknown;
  op?: unknown;
  org_id?: unknown;
  id?: unknown;
}

// Pure mapper: raw NOTIFY JSON to a typed LiveEvent; throws on anything malformed.
export function parseLivePayload(raw: string): LiveEvent {
  const parsed = JSON.parse(raw) as RawNotifyPayload;
  if (typeof parsed.table !== 'string' || parsed.table === '') {
    throw new Error(`desk_live payload: missing table ${JSON.stringify(parsed.table)}`);
  }
  if (typeof parsed.op !== 'string' || !VALID_OPS.includes(parsed.op as LiveEvent['op'])) {
    throw new Error(`desk_live payload: unrecognized op ${JSON.stringify(parsed.op)}`);
  }
  if (parsed.org_id !== null && typeof parsed.org_id !== 'string') {
    throw new Error(`desk_live payload: org_id must be a string or null, got ${JSON.stringify(parsed.org_id)}`);
  }
  if (typeof parsed.id !== 'string' && typeof parsed.id !== 'number') {
    throw new Error('desk_live payload: missing/invalid id');
  }
  return { table: parsed.table, op: parsed.op as LiveEvent['op'], orgId: parsed.org_id, id: String(parsed.id) };
}

export interface LiveWatcherHandle {
  /** Unsubscribes and closes the dedicated LISTEN connection. */
  stop: () => Promise<void>;
}

// Open the LISTEN connection and forward parsed desk_live notifies to onEvent.
export async function startLiveWatcher(
  connectionString: string,
  onEvent: (event: LiveEvent) => void,
): Promise<LiveWatcherHandle> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const { unlisten } = await sql.listen(
    LIVE_CHANNEL,
    (raw) => {
      try {
        onEvent(parseLivePayload(raw));
      } catch (err) {
        // Drop and log a malformed payload rather than crash the watcher.
        console.error('[live] dropped malformed desk_live payload:', err instanceof Error ? err.message : String(err));
      }
    },
    () => console.log('[live] LISTEN desk_live connected'),
  );
  return {
    stop: async () => {
      try {
        await unlisten();
      } catch (err) {
        console.error('[live] unlisten failed (connection likely already gone):', err instanceof Error ? err.message : String(err));
      }
      await sql.end({ timeout: 5 });
    },
  };
}

// ---------------------------------------------------------------------------
// The delta computer.
// ---------------------------------------------------------------------------

/** One screen someone watches: its bindings, its project, and the row key / end user the watch carries. */
export interface LiveTarget {
  sceneId: string;
  slug: string;
  projectId: string | null;
  bindings: SceneBinding[];
  rowKey?: string;
  endUserId?: string | null;
}

export interface LiveDeltaDeps {
  /** Runs a read in the org's context; the room pins the tenant and the end user here. */
  run<T>(orgId: string, fn: (sql: postgres.Sql) => Promise<T>, ctx?: { endUserId?: string | null }): Promise<T>;
  /** Who reads what right now; called once per burst. */
  targets(orgId: string): Promise<LiveTarget[]>;
  /** Delivers one push; the target names the watcher it is for (the room), or every client of the org (the hub). */
  push(orgId: string, msg: BindingDelta | EffectsPush, target: LiveTarget | null): void;
  /** Bursts of changes on one table collapse into one refresh. */
  debounceMs?: number;
}

export interface LiveDeltas {
  /** A desk_live pointer arrives: resolve the table it touched and refresh the bindings reading it. */
  onEvent(ev: LiveEvent): void;
  /** An in-process writer announces what it changed (the rooms database has no NOTIFY). */
  announce(a: { orgId: string; tables?: string[]; all?: boolean; executions?: string[] }): void;
  stop(): void;
}

/** The events a settled scene-action run records; the pointer names the row, the row names the execution. */
const SETTLE_EVENTS = new Set(['flow.run_succeeded', 'flow.run_failed']);

export function createLiveDeltas(deps: LiveDeltaDeps): LiveDeltas {
  const debounceMs = deps.debounceMs ?? 150;
  const pendingTables = new Map<string, { tables: Set<string>; all: boolean; timer: NodeJS.Timeout }>();
  let stopped = false;

  const refreshAffected = async (orgId: string, tables: Set<string>, all: boolean): Promise<void> => {
    let targets: LiveTarget[];
    try { targets = await deps.targets(orgId); } catch { return; }
    for (const target of targets) {
      const affected = target.bindings.filter((b) => b.kind === 'query' && (all || tables.has(b.table)));
      if (affected.length === 0) continue;
      const ctx = { endUserId: target.endUserId ?? null };
      for (const binding of affected) {
        let delta: BindingDelta;
        try {
          const r = await deps.run(orgId, (sql) => executeSceneBinding(sql, orgId, binding, target.projectId, { rowKey: target.rowKey }), ctx);
          delta = { kind: 'binding', orgId, sceneId: target.sceneId, scene: target.slug, binding: r.binding, rows: r.rows, text: r.text, error: null, ...(r.tick !== undefined ? { tick: r.tick } : {}) };
        } catch (err) {
          delta = { kind: 'binding', orgId, sceneId: target.sceneId, scene: target.slug, binding: binding.name, rows: [], text: null, error: err instanceof Error ? err.message : String(err) };
        }
        if (!stopped) deps.push(orgId, delta, target);
      }
    }
  };

  const schedule = (orgId: string, tables: string[], all: boolean): void => {
    if (stopped) return;
    const cur = pendingTables.get(orgId);
    if (cur !== undefined) {
      for (const t of tables) cur.tables.add(t);
      cur.all = cur.all || all;
      return;
    }
    const entry = {
      tables: new Set(tables), all,
      timer: setTimeout(() => {
        const e = pendingTables.get(orgId);
        pendingTables.delete(orgId);
        if (e !== undefined) void refreshAffected(orgId, e.tables, e.all);
      }, debounceMs),
    };
    entry.timer.unref?.();
    pendingTables.set(orgId, entry);
  };

  const pushEffects = async (orgId: string, executionId: string): Promise<void> => {
    let row: { status: string; envelope: unknown; error: string | null; trigger: Record<string, unknown> | null } | undefined;
    try {
      row = await deps.run(orgId, async (sql) => (await sql<{ status: string; envelope: unknown; error: string | null; trigger: Record<string, unknown> | null }[]>`
        select status, envelope, error, trigger from flow_executions where org_id = ${orgId} and id = ${executionId}`)[0]);
    } catch { return; }
    if (row === undefined || row.trigger?.['kind'] !== 'scene_action' || typeof row.trigger['sceneSlug'] !== 'string') return;
    if (row.status !== 'succeeded' && row.status !== 'failed') return;
    const env = flowEnvelopeSchema.safeParse(row.envelope);
    const msg: EffectsPush = {
      kind: 'effects', orgId, scene: row.trigger['sceneSlug'], execution: executionId, status: row.status,
      effects: row.status === 'succeeded' && env.success ? env.data.effects : [],
      ...(row.status === 'failed' ? { error: (row.error ?? 'the flow failed').slice(0, 300) } : {}),
    };
    let targets: LiveTarget[] = [];
    try { targets = await deps.targets(orgId); } catch { /* no watchers */ }
    const watching = targets.filter((t) => t.slug === msg.scene);
    if (watching.length === 0) { if (!stopped) deps.push(orgId, msg, null); return; }
    for (const t of watching) if (!stopped) deps.push(orgId, msg, t);
  };

  return {
    onEvent(ev: LiveEvent): void {
      if (stopped || ev.orgId === null) return;
      const orgId = ev.orgId;
      if (ev.table === 'dataset_rows') {
        void deps.run(orgId, async (sql) => (await sql<{ name: string }[]>`
          select d.name from dataset_rows r join datasets d on d.id = r.dataset_id
          where r.id = ${ev.id} and d.org_id = ${orgId}`)[0]?.name)
          .then((name) => { if (name !== undefined) schedule(orgId, [name], false); })
          .catch(() => undefined);
        return;
      }
      if (ev.table === 'events') {
        schedule(orgId, ['events'], false);
        void deps.run(orgId, async (sql) => (await sql<{ type: string; payload: Record<string, unknown> }[]>`
          select type, payload from events where id = ${Number(ev.id)} and org_id = ${orgId}`)[0])
          .then((row) => {
            if (row !== undefined && SETTLE_EVENTS.has(row.type) && typeof row.payload['executionId'] === 'string') void pushEffects(orgId, row.payload['executionId']);
          })
          .catch(() => undefined);
        return;
      }
      if (ev.table === 'runs' || ev.table === 'agents') schedule(orgId, [ev.table], false);
    },
    announce(a): void {
      if (stopped) return;
      if (a.all === true || (a.tables !== undefined && a.tables.length > 0)) schedule(a.orgId, a.tables ?? [], a.all === true);
      for (const id of a.executions ?? []) void pushEffects(a.orgId, id);
    },
    stop(): void {
      stopped = true;
      for (const e of pendingTables.values()) clearTimeout(e.timer);
      pendingTables.clear();
    },
  };
}

/** The workspace's targets: every active screen of the org with parsed bindings (the hub has no per-screen watch list). */
export async function activeSceneTargets(sql: postgres.Sql, orgId: string): Promise<LiveTarget[]> {
  const rows = await sql<{ id: string; slug: string; project_id: string | null; bindings: unknown }[]>`
    select id, slug, project_id, bindings from scenes where org_id = ${orgId} and status = 'active'`;
  const out: LiveTarget[] = [];
  for (const r of rows) {
    const parsed = sceneBindingsSchema.safeParse(r.bindings ?? []);
    if (!parsed.success || tablesReadBy(parsed.data).length === 0) continue;
    out.push({ sceneId: r.id, slug: r.slug, projectId: r.project_id, bindings: parsed.data });
  }
  return out;
}
