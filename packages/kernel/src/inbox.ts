import type postgres from 'postgres';
import { emitEvent } from './events.js';

export interface EscalateInput { orgId: string; kind: string; payload: Record<string, unknown>; }
export interface InboxItem { id: string; type: string; payload: Record<string, unknown>; createdAt: Date; }

/** Raise a human-facing escalation over the messages bus; `kind` rides in the payload. */
export async function escalate(sql: postgres.Sql, input: EscalateInput): Promise<{ messageId: string }> {
  const payload = { ...input.payload, kind: input.kind };
  const rows = await sql<{ id: string }[]>`
    insert into messages (org_id, type, payload) values (${input.orgId}, 'escalation', ${sql.json(payload as unknown as postgres.JSONValue)})
    returning id`;
  const row = rows[0];
  if (!row) throw new Error('escalate: insert returned no row');
  await emitEvent(sql, { orgId: input.orgId, actor: 'kernel.inbox', type: 'escalation.raised', payload: { messageId: row.id, kind: input.kind } });
  return { messageId: row.id };
}

/** Open escalations (unanswered), oldest first. */
export async function listInbox(sql: postgres.Sql, orgId: string): Promise<InboxItem[]> {
  const rows = await sql<{ id: string; type: string; payload: Record<string, unknown>; created_at: Date }[]>`
    select id, type, payload, created_at from messages
    where org_id = ${orgId} and type = 'escalation' and answered_at is null
    order by created_at asc`;
  return rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, createdAt: r.created_at }));
}

export interface AnswerEscalationInput { messageId: string; orgId: string; answer: Record<string, unknown>; }

/** Records a human answer and returns the original escalation context; scoped to orgId so a caller can only answer its own org's escalations. */
export async function answerEscalation(sql: postgres.Sql, input: AnswerEscalationInput): Promise<{ orgId: string; payload: Record<string, unknown> }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ org_id: string; payload: Record<string, unknown> }[]>`
      update messages set answered_at = now(), answer = ${tx.json(input.answer as unknown as postgres.JSONValue)}
      where id = ${input.messageId} and org_id = ${input.orgId} and type = 'escalation' and answered_at is null
      returning org_id, payload`;
    const row = rows[0];
    if (!row) throw new Error(`answerEscalation: not found or already answered: ${input.messageId}`);
    await emitEvent(tx as unknown as postgres.Sql, { orgId: row.org_id, actor: 'kernel.inbox', type: 'escalation.answered', payload: { messageId: input.messageId } });
    return { orgId: row.org_id, payload: row.payload };
  }) as Promise<{ orgId: string; payload: Record<string, unknown> }>;
}

