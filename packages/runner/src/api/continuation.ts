import type postgres from 'postgres';
import type { ModelMessage } from 'ai';
import type { ContinuationHistoryEntry } from '@nodeloom/core';

// Persists per-thread message arrays in Postgres; a disposable cache rebuilt from kernel history past the cap.

export interface ContinuationStore {
  /** Thread ids are globally unique uuids, so load needs no org. */
  load(threadId: string): Promise<ModelMessage[] | null>;
  save(threadId: string, orgId: string, messages: ModelMessage[]): Promise<void>;
}

/** Past this, the next turn re-seeds from the kernel's windowed history. */
export const MESSAGE_CAP = 80;

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** jsonb → messages, defensively: rows that lost their shape read as null (cold turn). */
function sanitize(value: unknown): ModelMessage[] | null {
  if (!Array.isArray(value)) return null;
  const out: ModelMessage[] = [];
  for (const m of value) {
    if (m === null || typeof m !== 'object') return null;
    const role = (m as { role?: unknown }).role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) return null;
    if ((m as { content?: unknown }).content === undefined) return null;
    out.push(m as ModelMessage);
  }
  return out.length > 0 ? out : null;
}

export function pgContinuationStore(sql: postgres.Sql): ContinuationStore {
  return {
    load: async (threadId) => {
      const [row] = await sql<{ messages: unknown }[]>`
        select messages from api_thread_messages
        where thread_id = ${threadId}`;
      return row === undefined ? null : sanitize(row.messages);
    },
    save: async (threadId, orgId, messages) => {
      await sql`
        insert into api_thread_messages (thread_id, org_id, messages, updated_at)
        values (${threadId}, ${orgId}, ${sql.json(messages as never)}, now())
        on conflict (thread_id) do update
          set messages = excluded.messages, updated_at = now()`;
    },
  };
}

/** Seeds a message array from record-derived history. */
export function seedFromHistory(history: ContinuationHistoryEntry[]): ModelMessage[] {
  return history.map((h): ModelMessage =>
    h.role === 'user'
      ? { role: 'user', content: h.text }
      : { role: 'assistant', content: h.text });
}

/** Picks prior messages: stored array if sane and under cap, else windowed history. */
export function priorMessagesFor(
  stored: ModelMessage[] | null, history: ContinuationHistoryEntry[],
): ModelMessage[] {
  if (stored !== null && stored.length > 0 && stored.length <= MESSAGE_CAP) return stored;
  return seedFromHistory(history);
}

/** Applies a fresh Anthropic cache breakpoint on the last prior message; returns clones. */
export function withAnthropicCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const cleaned = messages.map((m) => {
    if ((m as { providerOptions?: unknown }).providerOptions === undefined) return m;
    const { providerOptions: _drop, ...rest } = m as ModelMessage & { providerOptions?: unknown };
    return rest as ModelMessage;
  });
  if (cleaned.length === 0) return cleaned;
  const last = cleaned[cleaned.length - 1]!;
  cleaned[cleaned.length - 1] = {
    ...last,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  } as ModelMessage;
  return cleaned;
}

/** Builds the array to persist after a turn, stripped of providerOptions. */
export function nextStoredMessages(
  prior: ModelMessage[], userMessage: ModelMessage, responseMessages: ModelMessage[],
): ModelMessage[] {
  const strip = (m: ModelMessage): ModelMessage => {
    if ((m as { providerOptions?: unknown }).providerOptions === undefined) return m;
    const { providerOptions: _drop, ...rest } = m as ModelMessage & { providerOptions?: unknown };
    return rest as ModelMessage;
  };
  return [...prior.map(strip), strip(userMessage), ...responseMessages.map(strip)];
}
