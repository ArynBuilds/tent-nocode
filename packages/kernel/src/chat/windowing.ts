import type postgres from 'postgres';
import { getOrgConfig } from '../config.js';
import { emitEvent } from '../events.js';

// Stepped windowing: trims the chat view in one large chunk when the transcript exceeds the
// budget, leaving a deterministic handoff note. The kernel stays zero-model: the SUMMARY-BRIDGE
// (one cheap model call over the trimmed text) rides the runner's driver path, which rewrites
// the bridge through setWindowBridge after the trim.

// Deterministic estimate at ~4 chars per token.
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// After a step the kept tail sits at half the budget.
const KEEP_RATIO = 0.5;
// The trimmed text handed to the driver's summary call, newest kept.
const BRIDGE_SOURCE_CAP = 24_000;

interface EntryRow { role: string; created_at: Date; text: string | null; }

export interface WindowStepResult { stepped: boolean; trimmed: number; trimmedText?: string }

/** The driver-produced summary replaces the deterministic bridge; capped, plain text. */
export async function setWindowBridge(
  sql: postgres.Sql, input: { orgId: string; threadId: string; bridge: string },
): Promise<void> {
  await sql`update threads set window_bridge = ${input.bridge.slice(0, 2000)}
    where id = ${input.threadId} and org_id = ${input.orgId}`;
}

// Fire the window step if the post-cutoff transcript exceeds the view budget; the caller owns never-fail wrapping.
export async function windowStepIfDue(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string },
): Promise<WindowStepResult> {
  const cfg = await getOrgConfig(sql, input.orgId);
  const budget = cfg.chat.viewBudgetTokens;
  const threads = await sql<{ window_cutoff: Date | null; window_bridge: string | null; title: string }[]>`
    select window_cutoff, window_bridge, title from threads
    where id = ${input.threadId} and org_id = ${input.orgId}`;
  const thread = threads[0];
  if (!thread) return { stepped: false, trimmed: 0 };

  // The same transcript sources buildTurnView merges, filtered by the current cutoff.
  const cutoff = thread.window_cutoff;
  const entries = await sql<EntryRow[]>`
    select payload->>'role' as role, created_at, payload->>'text' as text from messages
    where org_id = ${input.orgId} and type = 'chat'
      and payload->>'threadId' = ${input.threadId} and payload->>'role' = 'user'
      ${cutoff ? sql`and created_at >= ${cutoff}` : sql``}
    union all
    select 'desk' as role, r.finished_at as created_at, r.output->>'result' as text
    from runs r
    where r.org_id = ${input.orgId} and r.thread_id = ${input.threadId} and r.kind = 'chat'
      and r.status = 'succeeded'
      ${cutoff ? sql`and r.finished_at >= ${cutoff}` : sql``}
    order by created_at asc`;

  const sized = entries.filter((e): e is EntryRow & { text: string } => e.text !== null);
  const totalTokens = estimateTokens(
    sized.reduce((n, e) => n + e.text.length, 0) + (thread.window_bridge?.length ?? 0));
  if (totalTokens <= budget) return { stepped: false, trimmed: 0 };

  // Walk newest-backwards until the kept tail fills KEEP_RATIO of the budget.
  const keepTokens = Math.floor(budget * KEEP_RATIO);
  let acc = 0;
  let cutIdx = sized.length;
  for (let i = sized.length - 1; i >= 0; i--) {
    acc += estimateTokens(sized[i]!.text.length);
    if (acc > keepTokens) break;
    cutIdx = i;
  }
  if (cutIdx <= 0 || cutIdx >= sized.length) return { stepped: false, trimmed: 0 };

  const trimmed = sized.slice(0, cutIdx);
  const newCutoff = sized[cutIdx]!.created_at;

  // The deterministic handoff note.
  const first = trimmed[0]!.created_at.toISOString().slice(0, 10);
  const last = trimmed[trimmed.length - 1]!.created_at.toISOString().slice(0, 10);
  const bridge = `${trimmed.length} earlier messages (${first} to ${last}) left this view; `
    + 'the full record retains them and can be recalled on demand.';

  await sql`update threads set window_cutoff = ${newCutoff}, window_bridge = ${bridge}
    where id = ${input.threadId} and org_id = ${input.orgId}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.chat.window', type: 'thread.window_stepped',
    payload: {
      threadId: input.threadId, trimmed: trimmed.length,
      cutoff: newCutoff.toISOString(), bridgeChars: bridge.length,
    },
  });
  const trimmedText = trimmed.map((e) => `${e.role}: ${e.text}`).join('\n\n').slice(-BRIDGE_SOURCE_CAP);
  return { stepped: true, trimmed: trimmed.length, trimmedText };
}
