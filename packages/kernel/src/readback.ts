import type postgres from 'postgres';

export interface ReadRunExcerptResult {
  found: boolean;
  runId?: string;
  threadTitle?: string | null;
  at?: string;
  excerpt?: string;
  truncated?: boolean;
}

/** Strips ANSI and control chars but keeps newlines and tabs. */
function cleanExcerpt(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // eslint-disable-next-line no-control-regex
  return noAnsi.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

/** Reads a bounded excerpt of a run's output; accepts `run:<uuid>` or a bare uuid; truncation is flagged. */
export async function readRunExcerpt(
  sql: postgres.Sql,
  orgId: string,
  runKey: string,
  opts?: { maxChars?: number },
): Promise<ReadRunExcerptResult> {
  const maxChars = opts?.maxChars ?? 2000;
  const runId = runKey.startsWith('run:') ? runKey.slice(4) : runKey;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    return { found: false };
  }

  const rows = await sql<{ id: string; created_at: Date; result: string | null; tail: string | null; thread_title: string | null }[]>`
    select r.id, r.created_at, r.output->>'result' as result, r.output_tail as tail, t.title as thread_title
    from runs r
    left join threads t on t.id = r.thread_id
    where r.id = ${runId} and r.org_id = ${orgId}`;
  const row = rows[0];
  if (!row) return { found: false };

  const raw = row.result ?? row.tail ?? '';
  const clean = cleanExcerpt(raw);
  const truncated = clean.length > maxChars;
  return {
    found: true,
    runId: row.id,
    threadTitle: row.thread_title,
    at: row.created_at.toISOString(),
    excerpt: truncated ? clean.slice(0, maxChars) : clean,
    truncated,
  };
}
