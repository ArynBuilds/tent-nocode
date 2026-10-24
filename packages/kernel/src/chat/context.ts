import { statsGlance, type ArrayStats, type ContinuationHistoryEntry } from '@nodeloom/core';
import type postgres from 'postgres';
import { numberLines, projectDialectLens } from '../dialect.js';
import { sanitizeLabel } from '../sanitize.js';
import { VENDORED_FONT_FAMILIES } from '../scenes/hostPage.js';
import { getOpenIntent } from './intents.js';

export interface BuildTurnContextInput {
  orgId: string;
  threadId: string;
  /** Merged USER/DESK entries kept in the transcript. Default 200 — a runaway guard, not a working window. */
  recentTurns?: number;
  /** Review variant: mission + outcomes + active scope only — no transcript, no surfaces. */
  review?: boolean;
}

export interface BuildTurnContextResult { contextText: string; }

/** The rebuild split for caching: `history` = the transcript as message entries; `volatileText` = everything except the transcript; `contextText` = the one-block cold-path form. */
export interface BuildTurnViewResult extends BuildTurnContextResult {
  history: ContinuationHistoryEntry[];
  volatileText: string;
}

interface ThreadRow {
  title: string; mode: string | null; created_by: string;
  /** Entries before the cutoff left the view at a window step; the bridge paragraph replaces them. */
  window_cutoff: Date | null; window_bridge: string | null;
  /** The thread's project — always present. */
  project_id: string;
}
interface WorkRunRow { id: string; status: string; prompt: string; }
interface UserMsgRow { id: string; created_at: Date; text: string; }
interface DeskRunRow { id: string; created_at: Date; started_at: Date; text: string | null; }
interface ConversationEntry { createdAt: Date; id: string; role: 'user' | 'desk'; text: string; }

/** Renders one turn with continuation lines indented, so raw text can never forge a column-0 envelope line. */
export function indentContinuation(role: 'user' | 'desk', text: string): string {
  const prefix = role === 'user' ? 'USER' : 'DESK';
  const lines = text.split('\n');
  return lines
    .map((line, i) => (i === 0 ? `${prefix}: ${line}` : `  ${line}`))
    .join('\n');
}

/** One envelope block: a kebab name + one-line JSON; JSON escaping stops stored data forging a block. */
function block(name: string, value: unknown): string {
  return `${name}: ${JSON.stringify(value)}`;
}

/** The envelope's opening line: present-tense existence claims come from these blocks, never memory. */
const ENVELOPE_HEADER =
  'ENVELOPE (what exists RIGHT NOW - ground truth rebuilt from the record every turn; '
  + 'conversation and memory are history; the document line is the whole project, line-numbered - your first read):';

/**
 * Deterministically rebuilds a chat turn's full context from the record: THREAD line, then the
 * append-only transcript, then the structured envelope. Order is stable-before-volatile so turn
 * N's transcript is a byte prefix of turn N+1's. Ordering rides stored created_at (id tie-break),
 * never wall-clock, so unchanged rows produce the exact same string. The transcript is built
 * from the messages table only — never tool noise.
 */
export async function buildTurnContext(
  sql: postgres.Sql,
  input: BuildTurnContextInput,
): Promise<BuildTurnContextResult> {
  const { contextText } = await buildTurnView(sql, input);
  return { contextText };
}

/** The full turn view (Tier 28 split — see BuildTurnViewResult). */
export async function buildTurnView(
  sql: postgres.Sql,
  input: BuildTurnContextInput,
): Promise<BuildTurnViewResult> {
  const recentTurns = input.recentTurns ?? 200;

  const threads = await sql<ThreadRow[]>`
    select title, mode, created_by, window_cutoff, window_bridge, project_id from threads
    where id = ${input.threadId} and org_id = ${input.orgId} and deleted_at is null`;
  const thread = threads[0];
  if (!thread) throw new Error(`buildTurnContext: thread not found: ${input.threadId}`);
  const cutoff = thread.window_cutoff;

  // work block source: only `kind='work'` runs — the thread's own chat turns are not listable work.
  const workRuns = await sql<WorkRunRow[]>`
    select id, status, coalesce(prompt, '') as prompt from runs
    where org_id = ${input.orgId} and thread_id = ${input.threadId} and kind = 'work'
    order by created_at asc, id asc`;

  // Transcript sources, fetched separately then merged below.
  const userMsgs = await sql<UserMsgRow[]>`
    select id, created_at, payload->>'text' as text from messages
    where org_id = ${input.orgId} and type = 'chat'
      and payload->>'threadId' = ${input.threadId} and payload->>'role' = 'user'
      ${cutoff ? sql`and created_at >= ${cutoff}` : sql``}
    order by created_at asc, id asc`;
  const deskRuns = await sql<DeskRunRow[]>`
    select r.id, r.finished_at as created_at, r.created_at as started_at, r.output ->> 'result' as text
    from runs r
    where r.org_id = ${input.orgId} and r.thread_id = ${input.threadId} and r.kind = 'chat'
      and r.status = 'succeeded'
      ${cutoff ? sql`and r.finished_at >= ${cutoff}` : sql``}
    order by r.finished_at asc, r.id asc`;

  const section1 = `THREAD: ${sanitizeLabel(thread.title)} · mode=${thread.mode ?? 'default'}`;

  const envWork = workRuns.length > 0
    ? block('work', workRuns.map((j) => ({
        id: j.id.slice(0, 8), status: j.status, prompt: sanitizeLabel(j.prompt).slice(0, 80),
      })))
    : null;

  // user block: the thread creator's display name when known. Never-fail: no row = no block.
  let envUser: string | null = null;
  try {
    const [prof] = await sql<{ display_name: string | null }[]>`
      select display_name from profiles where user_id = ${thread.created_by}`;
    if (prof?.display_name != null && prof.display_name.length > 0) {
      envUser = block('user', { name: sanitizeLabel(prof.display_name).slice(0, 80) });
    }
  } catch { /* block omitted */ }

  // fonts block: the vendored family names — static kernel truth, byte-stable.
  const envFonts = block('fonts', VENDORED_FONT_FAMILIES);

  // Mission block: rebuilt from the record every wake; omitted when no live intent exists.
  let envMission: string | null = null;
  const intent = await getOpenIntent(sql, input.orgId, input.threadId);
  if (intent) {
    envMission = block('mission', {
      status: intent.status,
      note: 'check settled outcomes against each part\'s acceptance line, mark it with evidence, act on the next pending part',
      parts: intent.parts.map((p, i) => ({
        part: i, status: p.status, text: sanitizeLabel(p.text), acceptance: sanitizeLabel(p.acceptance),
        ...(p.runId ? { run: p.runId.slice(0, 8) } : {}),
        ...(p.note ? { note: sanitizeLabel(p.note) } : {}),
      })),
      ...(intent.status === 'parked' && intent.note ? { parked: sanitizeLabel(intent.note) } : {}),
    });
  }

  const merged: ConversationEntry[] = [
    ...userMsgs.map((m) => ({ createdAt: m.created_at, id: m.id, role: 'user' as const, text: m.text })),
    ...deskRuns
      .filter((r): r is DeskRunRow & { text: string } => r.text !== null)
      .map((r) => ({ createdAt: r.created_at, id: r.id, role: 'desk' as const, text: r.text })),
  ].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    if (byTime !== 0) return byTime;
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1; // a user turn precedes its own reply
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const sliced = merged.slice(Math.max(0, merged.length - recentTurns));
  // After a window step the bridge opens the transcript; prepended after the slice so it can never be sliced out.
  const windowed: ConversationEntry[] = thread.window_bridge !== null && cutoff !== null
    ? [{
        createdAt: cutoff, id: 'window-bridge', role: 'desk' as const,
        text: `[Earlier in this conversation — summarized; the full record retains everything] ${thread.window_bridge}`,
      }, ...sliced]
    : sliced;

  const section4 = [
    'RECENT CONVERSATION:',
    ...windowed.map((e) => indentContinuation(e.role, e.text)),
  ].join('\n');

  // Surfaces block: always rendered with explicit [] markers — the desk must see absence or it invents presence.
  const pid = thread.project_id;
  const tabs = await sql<{ slug: string; title: string; status: string; current_version: number; scene_id: string | null }[]>`
    select slug, title, status, current_version, scene_id from tabs
    where org_id = ${input.orgId} and status <> 'deleted' and project_id = ${pid}
    order by slug asc`;
  const datasets = await sql<{ name: string; n: string }[]>`
        select d.name, count(r.id) as n from datasets d
        left join dataset_rows r on r.dataset_id = d.id
        where d.org_id = ${input.orgId} and d.project_id = ${pid} and d.deleted_at is null
        group by d.name order by d.name asc`;
  // Registered derived outputs are bindable inventory, project-scoped.
  const outputs = await sql<{ name: string; kind: string; descriptor: Record<string, unknown>; staleAt: Date | null }[]>`
        select distinct on (o.name) o.name, o.kind, o.descriptor, o.stale_at as "staleAt" from derived_outputs o
        where o.org_id = ${input.orgId} and o.project_id = ${pid} and o.status = 'registered'
        order by o.name asc, o.created_at desc, o.id desc`;
  const outputHeadline = (o: { name: string; kind: string; descriptor: Record<string, unknown>; staleAt?: Date | null }): string => {
    // Staleness is never silent.
    const stale = o.staleAt != null ? ' · stale' : '';
    if (o.kind === 'array') {
      const shape = Array.isArray(o.descriptor['shape']) ? (o.descriptor['shape'] as number[]).join('×') : '?';
      const s = o.descriptor['stats'] as Record<string, unknown> | null | undefined;
      const glance = s && typeof s['mean'] === 'number'
        ? ` · ${statsGlance(s as unknown as ArrayStats)}` : '';
      return `array ${String(o.descriptor['dtype'] ?? '?')} ${shape}${glance}${stale}`;
    }
    return `raster ${String(o.descriptor['format'] ?? '?')}${stale}`;
  };
  // Flows, triggers, and connections are surfaces too - absence here taught the desk they did not exist.
  const flows = await sql<{ name: string; doc: unknown; enabled: boolean }[]>`
        select name, doc, enabled from flows
        where org_id = ${input.orgId} and project_id = ${pid} and deleted_at is null
        order by name asc`;
  const triggers = await sql<{ kind: string; spec: Record<string, unknown> }[]>`
        select kind, spec from triggers
        where org_id = ${input.orgId} and project_id = ${pid} and revoked_at is null
        order by created_at asc`;
  const connections = await sql<{ id: string; integration: string; label: string; status: string }[]>`
        select id, integration, label, status from integration_connections
        where org_id = ${input.orgId} and project_id = ${pid}
        order by label asc`;
  const flowGlance = (doc: unknown): { steps: number; kinds: string[] } => {
    const steps = (doc as { steps?: Record<string, { kind?: string }> } | null)?.steps ?? {};
    const kinds = [...new Set(Object.values(steps).map((s) => s.kind ?? '?'))];
    return { steps: Object.keys(steps).length, kinds: kinds.slice(0, 12) };
  };
  const envSurfaces = block('surfaces', {
    screens: tabs.map((t) => ({
      title: sanitizeLabel(t.title), slug: t.slug, status: t.status, v: t.current_version,
    })),
    datasets: datasets.map((d) => ({ name: d.name, rows: Number(d.n) })),
    flows: flows.map((f) => ({ name: f.name, enabled: f.enabled, ...flowGlance(f.doc) })),
    triggers: triggers.map((t) => ({ kind: t.kind, spec: sanitizeLabel(JSON.stringify(t.spec)).slice(0, 80) })),
    connections: connections.map((c) => ({ id: c.id, service: c.integration, label: sanitizeLabel(c.label), status: c.status })),
    outputs: outputs.map((o) => ({ name: o.name, kind: o.kind, headline: sanitizeLabel(outputHeadline(o)) })),
  });

  // document block: the whole project lens at full depth, line-numbered as edit's replace expects it - never capped; an error renders honest, never silent.
  let envDocument: string;
  try {
    const lens = await projectDialectLens(sql, { orgId: input.orgId, projectId: pid });
    envDocument = block('document', { code: numberLines(lens.code) });
  } catch (err) {
    envDocument = block('document', { code: null, error: sanitizeLabel(err instanceof Error ? err.message : String(err)).slice(0, 200) });
  }

  // active-scope block: the thread's project as truncated metadata + counts — never the tree.
  let scopeProject: Record<string, unknown> | null = null;
  try {
    const [proj] = await sql<{ name: string; kind: 'app' | 'website' | null }[]>`
      select name, kind from projects where id = ${pid} and org_id = ${input.orgId} and archived_at is null`;
    if (proj) {
      const [ops] = await sql<{ n: string }[]>`
        select count(distinct name) as n from operations
        where org_id = ${input.orgId} and project_id = ${pid}`;
      const [notes] = await sql<{ n: string }[]>`
        select count(*) as n from project_notes
        where org_id = ${input.orgId} and project_id = ${pid}
          and superseded_by is null and deleted_at is null`;
      scopeProject = {
        name: sanitizeLabel(proj.name).slice(0, 80),
        kind: proj.kind,
        counts: {
          screens: tabs.length, datasets: datasets.length,
          operations: Number(ops?.n ?? 0), outputs: outputs.length,
          flows: flows.length, triggers: triggers.length, connections: connections.length,
          notes: Number(notes?.n ?? 0),
        },
        truncated: true,
      };
    }
  } catch { /* project half omitted - the block still renders honest null */ }
  const envScope = block('active-scope', { project: scopeProject });

  // Rejection feedback: an action whose params failed validation must be seen on the next turn; only last-turn rejections render.
  let envRejected: string | null = null;
  try {
    const lastDesk = deskRuns[deskRuns.length - 1];
    if (lastDesk) {
      // Window on the last turn's START: approvals execute async, so a failure can land while the next turn runs.
      const rej = await sql<{ action: string | null; reason: string | null }[]>`
        select payload->>'action' as action, payload->>'reason' as reason
        from events
        where org_id = ${input.orgId} and type = 'action.invalid'
          and payload->>'threadId' = ${input.threadId}
          and created_at >= ${lastDesk.started_at}
        order by id asc limit 5`;
      if (rej.length > 0) {
        envRejected = block('rejected-actions', {
          note: 'your previous reply\'s action fence was DROPPED - its params failed validation; fix exactly what is named, never re-emit the same fence unchanged',
          dropped: rej.map((r) => ({
            action: sanitizeLabel(r.action ?? '?'),
            reason: sanitizeLabel((r.reason ?? 'invalid params').slice(0, 300)),
          })),
        });
      }
    }
  } catch { /* block omitted */ }

  // Review variant: mission + outcomes + active scope, nothing else.
  if (input.review === true) {
    let sectionOutcomes: string | null = null;
    try {
      const partRuns = [...new Set((intent?.parts ?? [])
        .map((p) => p.runId).filter((id): id is string => typeof id === 'string'))];
      const outcomeJobs = partRuns.length > 0
        ? await sql<{ id: string; status: string; prompt: string; result: string | null }[]>`
            select r.id, r.status, coalesce(r.prompt, '') as prompt, r.output->>'result' as result
            from runs r where r.org_id = ${input.orgId} and r.id = any(${partRuns}::uuid[])`
        : workRuns.map((j) => ({ ...j, result: null }));
      const changeEvs = await sql<{ payload: { runId?: string; created?: number; modified?: number; deleted?: number; sample?: string[] } }[]>`
        select payload from events
        where org_id = ${input.orgId} and type = 'run.workspace_changes'
          and payload->>'runId' = any(${outcomeJobs.map((j) => j.id)}::text[])
        order by id desc`;
      const changesByJob = new Map<string, string>();
      for (const e of changeEvs) {
        const jid = e.payload.runId;
        if (typeof jid === 'string' && !changesByJob.has(jid)) {
          changesByJob.set(jid,
            ` — files: +${e.payload.created ?? 0} ~${e.payload.modified ?? 0} -${e.payload.deleted ?? 0}`
            + (e.payload.sample && e.payload.sample.length > 0 ? ` (${e.payload.sample.slice(0, 5).join(', ')})` : ''));
        }
      }
      if (outcomeJobs.length > 0) {
        sectionOutcomes = [
          'OUTCOMES (the settled work — judge each against its part\'s acceptance line):',
          ...outcomeJobs.map((j) =>
            `- ${j.id.slice(0, 8)} [${j.status}] ${sanitizeLabel(j.prompt).slice(0, 80)}${changesByJob.get(j.id) ?? ''}`
            + (j.result !== null && j.result.length > 0 ? `\n  report: ${sanitizeLabel(j.result).replace(/\s+/g, ' ').slice(0, 600)}` : '')),
        ].join('\n');
      }
    } catch { /* section omitted */ }
    const reviewText = [section1, envMission, sectionOutcomes, envScope, envRejected]
      .filter((s): s is string => s !== null)
      .join('\n\n');
    return { contextText: reviewText, history: [], volatileText: reviewText };
  }

  // The envelope: one block per line; near-static blocks lead, the document follows the surfaces it details, churny blocks trail; order is fixed.
  const envelope = [
    ENVELOPE_HEADER,
    envUser, envFonts, envScope, envSurfaces, envDocument, envWork, envMission, envRejected,
  ].filter((s): s is string => s !== null).join('\n');

  // Stable → volatile: the envelope comes last so it never poisons the transcript's cache prefix.
  const contextText = [section1, section4, envelope].join('\n\n');
  // The transcript as engine-neutral entries — raw text; history entries are separate real messages.
  const history: ContinuationHistoryEntry[] = windowed.map((e) => ({
    role: e.role === 'user' ? 'user' as const : 'assistant' as const,
    text: e.text,
    at: e.createdAt.toISOString(),
  }));
  const volatileText = [section1, envelope].join('\n\n');
  return { contextText, history, volatileText };
}
