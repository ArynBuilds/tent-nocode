import type postgres from 'postgres';
import { flowEnvelopeSchema } from '@tent-nocode/core';
import { getFlow } from '../flows/store.js';

// Holds a webhook caller up to ~8s for an answering flow's recorded answer; past the cap the 204 answers.

export interface WebhookHoldOptions {
  /** Hold cap in ms (default 8000). */
  capMs?: number;
  /** Poll cadence in ms (default 500). */
  cadenceMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallerAnswer {
  status: 200 | 201;
  answer: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Hold for the flow's recorded answer to this event; null means no answer arrived.
export async function holdForCallerAnswer(
  sql: postgres.Sql,
  input: { orgId: string; token: string; eventId: string },
  opts: WebhookHoldOptions = {},
): Promise<CallerAnswer | null> {
  // One select finds answering triggers and snapshots each pre-hold execution id.
  const triggers = await sql<Array<{ id: string; project_id: string | null; action: { flow?: string }; edge_state: Record<string, unknown> | null }>>`
    select id, project_id, action, edge_state from triggers
    where org_id = ${input.orgId} and kind = 'webhook_in' and enabled = true and revoked_at is null
      and spec->>'endpoint' = ${input.token} and action->>'type' = 'start_flow'`;
  const answering: string[] = [];
  // trigger id -> its execution id before our event was consumed (or null)
  const before = new Map<string, string | null>();
  for (const t of triggers) {
    const flow = await getFlow(sql, input.orgId, { projectId: t.project_id ?? undefined, name: t.action.flow ?? 'main' });
    if (flow === null) continue;
    const steps = (flow.doc as { steps?: Record<string, { kind?: string }> }).steps ?? {};
    if (!Object.values(steps).some((s) => s?.kind === 'answer-caller')) continue;
    answering.push(t.id);
    const prev = (t.edge_state ?? {})['activeFlowExecutionId'];
    before.set(t.id, typeof prev === 'string' ? prev : null);
  }
  if (answering.length === 0) return null;

  const capMs = opts.capMs ?? 8000;
  const cadenceMs = opts.cadenceMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + capMs;
  const open = new Set(answering);
  // trigger id -> the fresh execution born for our event, once matched
  const matched = new Map<string, string>();

  while (open.size > 0 && Date.now() < deadline) {
    await sleep(cadenceMs);
    for (const trigId of [...open]) {
      let execId = matched.get(trigId) ?? null;
      if (execId === null) {
        const [t] = await sql<Array<{ edge_state: Record<string, unknown> | null }>>`
          select edge_state from triggers where id = ${trigId}`;
        const es = t?.edge_state ?? {};
        // The sweep has not consumed our event yet.
        if (es['lastEventId'] !== String(input.eventId)) continue;
        const cand = es['activeFlowExecutionId'];
        // Consumed without a fresh fire: never answer with another call's run.
        if (typeof cand !== 'string' || cand === before.get(trigId)) { open.delete(trigId); continue; }
        execId = cand;
        matched.set(trigId, cand);
      }
      const [run] = await sql<Array<{ status: string; envelope: unknown }>>`
        select status, envelope from flow_executions
        where id = ${execId} and org_id = ${input.orgId}`;
      if (run === undefined) { open.delete(trigId); continue; }
      const env = flowEnvelopeSchema.safeParse(run.envelope);
      const ca = env.success ? env.data.callerAnswer : undefined;
      if (ca !== undefined) return { status: ca.status, answer: ca.answer };
      // Settled without an answer: stop watching this trigger.
      if (run.status === 'succeeded' || run.status === 'failed') open.delete(trigId);
    }
  }
  return null;
}
