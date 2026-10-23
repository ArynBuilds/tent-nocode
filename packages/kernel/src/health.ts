import type postgres from 'postgres';
import { RESCUE_TANK_CAP } from './chat/intents.js';

// Org health: deterministic SQL over the record, numbers only.

/** Mirrors ClaudeCodeDriver's default timeout (claudeDriver.ts) — no config key exists for it. */
export const RUN_TIMEOUT_MS = 2_700_000;
/** Grind threshold: a run that burned >=80% of the timeout and delivered nothing. */
export const GRIND_RATIO = 0.8;

export interface HealthReport {
  spend: {
    tokens30d: number;
    usd30d: number;
    topThreads: { threadId: string; title: string | null; tokens: number; usd: number }[];
    grindRuns30d: number;
    /** cache_read / (input + cache_read + cache_write); 0 when no usage is recorded. */
    cacheHitRate30d: number;
    /** Average effective tokens per chat turn (claudeDriver weighting). */
    avgChatTurnTokens30d: number;
    /** Engine mid-run compactions — should always be zero; non-zero means a session lived too long. */
    compactedAnomalies30d: number;
  };
  honesty: {
    succeededRuns30d: number;
    failedRuns30d: number;
    honestEmptyJobs30d: number;
    /** Rows the tab write door refused — surfaces schema drift or a misbuilt tab UI. */
    tabWriteRejects30d: number;
  };
  loop: {
    openIntents: number;
    parkedIntents: number;
    parkedOver24h: number;
    /** Rescue-tank-exhausted missions. */
    budgetExhausted: number;
    rescueFirings30d: number;
    cancelled30d: number;
  };
  /** Work-diet gauges — numbers that should fall and stay down. */
  discipline: {
    /** Avg chars of work-run reports (runs.output.result). */
    avgReportChars30d: number;
    /** Wake runs spawned while another desk turn of the same thread was live. */
    doubleReporterWakes30d: number;
    /** Total effective tokens per done mission part; 0 when no parts settled. */
    effPerSettledPart30d: number;
  };
  errors: {
    clusters7d: { type: string; count: number }[];
    daemonRestarts7d: number;
  };
  /** Browse and connector counts over run.activity tool steps. */
  browse: {
    pages30d: number;
    connectorCalls30d: number;
    /** External MCP connection tool calls (mcp__ext-*), 30d. */
    externalMcpCalls30d: number;
    topDomains: { domain: string; pages: number }[];
  };
  generatedAt: string;
}

async function spendGroup(sql: postgres.Sql, orgId: string): Promise<HealthReport['spend']> {
  const [totals] = await sql<{ tokens: string; usd: string }[]>`
    select coalesce(sum(tokens_used), 0) as tokens, coalesce(sum(cost_estimate), 0) as usd
    from runs where org_id = ${orgId} and created_at > now() - interval '30 days'`;
  const top = await sql<{ thread_id: string; title: string | null; tokens: string; usd: string }[]>`
    select r.thread_id, t.title,
           coalesce(sum(r.tokens_used), 0) as tokens, coalesce(sum(r.cost_estimate), 0) as usd
    from runs r
    left join threads t on t.id = r.thread_id
    where r.org_id = ${orgId} and r.created_at > now() - interval '30 days'
      and r.thread_id is not null
    group by r.thread_id, t.title
    order by coalesce(sum(r.cost_estimate), 0) desc, coalesce(sum(r.tokens_used), 0) desc
    limit 5`;
  const [grind] = await sql<{ n: string }[]>`
    select count(*) as n from runs
    where org_id = ${orgId} and created_at > now() - interval '30 days'
      and duration_ms >= ${GRIND_RATIO * RUN_TIMEOUT_MS}
      and coalesce(output->>'result', '') = ''`;
  // Effective-token weighting mirrors claudeDriver's tokensFromUsage.
  const [cache] = await sql<{ r_in: string; r_read: string; r_write: string }[]>`
    select coalesce(sum((usage->>'inputTokens')::numeric), 0) as r_in,
           coalesce(sum((usage->>'cacheReadTokens')::numeric), 0) as r_read,
           coalesce(sum((usage->>'cacheWriteTokens')::numeric), 0) as r_write
    from runs
    where org_id = ${orgId} and created_at > now() - interval '30 days' and usage is not null`;
  const denom = Number(cache!.r_in) + Number(cache!.r_read) + Number(cache!.r_write);
  const [chatCost] = await sql<{ avg_eff: string }[]>`
    select coalesce(avg(
        coalesce((r.usage->>'inputTokens')::numeric, 0)
      + 1.25 * coalesce((r.usage->>'cacheWriteTokens')::numeric, 0)
      + 0.1  * coalesce((r.usage->>'cacheReadTokens')::numeric, 0)
      + 5    * coalesce((r.usage->>'outputTokens')::numeric, 0)), 0) as avg_eff
    from runs r
    where r.org_id = ${orgId} and r.kind = 'chat'
      and r.created_at > now() - interval '30 days' and r.usage is not null`;
  const [compactions] = await sql<{ n: string }[]>`
    select count(*) as n from events
    where org_id = ${orgId} and type = 'session.compacted_anomaly'
      and created_at > now() - interval '30 days'`;
  return {
    tokens30d: Number(totals!.tokens),
    usd30d: Number(totals!.usd),
    topThreads: top.map((r) => ({
      threadId: r.thread_id, title: r.title, tokens: Number(r.tokens), usd: Number(r.usd),
    })),
    grindRuns30d: Number(grind!.n),
    cacheHitRate30d: denom > 0 ? Number(cache!.r_read) / denom : 0,
    avgChatTurnTokens30d: Number(chatCost!.avg_eff),
    compactedAnomalies30d: Number(compactions!.n),
  };
}

async function honestyGroup(sql: postgres.Sql, orgId: string): Promise<HealthReport['honesty']> {
  const [runs] = await sql<{ ok: string; bad: string }[]>`
    select count(*) filter (where status = 'succeeded') as ok,
           count(*) filter (where status = 'failed') as bad
    from runs where org_id = ${orgId} and created_at > now() - interval '30 days'`;
  const [empty] = await sql<{ n: string }[]>`
    select count(*) as n from runs r
    where r.org_id = ${orgId} and r.kind = 'work' and r.status = 'succeeded'
      and r.created_at > now() - interval '30 days'
      and coalesce(r.output->>'result', '') = ''`;
  const [tabRejects] = await sql<{ n: string | null }[]>`
    select sum(jsonb_array_length(payload->'rejected')) as n from events
    where org_id = ${orgId} and type = 'tab.write'
      and created_at > now() - interval '30 days'`;
  return {
    succeededRuns30d: Number(runs!.ok),
    failedRuns30d: Number(runs!.bad),
    honestEmptyJobs30d: Number(empty!.n),
    tabWriteRejects30d: Number(tabRejects?.n ?? 0),
  };
}

async function loopGroup(
  sql: postgres.Sql, orgId: string,
): Promise<HealthReport['loop']> {
  // budgetExhausted counts rescue-tank-exhausted missions (RESCUE_TANK_CAP).
  const live = await sql<{ status: string; wakes_used: number; aged: boolean }[]>`
    select i.status, i.wakes_used,
           (i.status = 'parked' and i.updated_at < now() - interval '24 hours') as aged
    from thread_intents i
    where i.org_id = ${orgId} and i.status in ('open', 'parked')`;
  const exhausted = live.filter((i) => i.wakes_used >= RESCUE_TANK_CAP).length;
  const [counts] = await sql<{ cancelled: string; rescues: string }[]>`
    select (select count(*) from thread_intents
            where org_id = ${orgId} and status = 'cancelled'
              and updated_at > now() - interval '30 days') as cancelled,
           (select count(*) from runs
            where org_id = ${orgId} and created_at > now() - interval '30 days'
              and input->>'loopRescue' = 'true') as rescues`;
  return {
    openIntents: live.filter((i) => i.status === 'open').length,
    parkedIntents: live.filter((i) => i.status === 'parked').length,
    parkedOver24h: live.filter((i) => i.aged).length,
    budgetExhausted: exhausted,
    rescueFirings30d: Number(counts!.rescues),
    cancelled30d: Number(counts!.cancelled),
  };
}

async function disciplineGroup(sql: postgres.Sql, orgId: string): Promise<HealthReport['discipline']> {
  const [report] = await sql<{ avg_chars: string }[]>`
    select coalesce(avg(length(r.output->>'result')), 0) as avg_chars
    from runs r
    where r.org_id = ${orgId} and r.kind = 'work' and r.status = 'succeeded'
      and r.created_at > now() - interval '30 days'
      and coalesce(r.output->>'result', '') <> ''`;
  // A wake run born while another desk turn of the same thread was still live.
  const [double] = await sql<{ n: string }[]>`
    select count(*) as n
    from runs w
    where w.org_id = ${orgId} and w.kind = 'chat' and w.input->>'loopWake' is not null
      and w.created_at > now() - interval '30 days'
      and exists (
        select 1 from runs a
        where a.org_id = w.org_id and a.thread_id = w.thread_id and a.kind = 'chat'
          and a.id != w.id and a.created_at <= w.created_at
          and (a.finished_at is null or a.finished_at >= w.created_at)
          and a.status in ('running', 'succeeded', 'failed'))`;
  const [eff] = await sql<{ eff: string }[]>`
    select coalesce(sum(
        coalesce((usage->>'inputTokens')::numeric, 0)
      + 1.25 * coalesce((usage->>'cacheWriteTokens')::numeric, 0)
      + 0.1  * coalesce((usage->>'cacheReadTokens')::numeric, 0)
      + 5    * coalesce((usage->>'outputTokens')::numeric, 0)), 0) as eff
    from runs
    where org_id = ${orgId} and created_at > now() - interval '30 days' and usage is not null`;
  const [parts] = await sql<{ n: string }[]>`
    select coalesce(sum((select count(*) from jsonb_array_elements(i.parts) p
                         where p->>'status' = 'done')), 0) as n
    from thread_intents i
    where i.org_id = ${orgId} and i.updated_at > now() - interval '30 days'`;
  const settled = Number(parts!.n);
  return {
    avgReportChars30d: Math.round(Number(report!.avg_chars)),
    doubleReporterWakes30d: Number(double!.n),
    effPerSettledPart30d: settled > 0 ? Math.round(Number(eff!.eff) / settled) : 0,
  };
}

/** The closed failure-class list clusters group by (mirrors kernel emit sites). */
const FAILURE_EVENT_TYPES = ['run.failed'];

async function errorsGroup(sql: postgres.Sql, orgId: string): Promise<HealthReport['errors']> {
  const clusters = await sql<{ type: string; n: string }[]>`
    select type, count(*) as n from events
    where org_id = ${orgId} and created_at > now() - interval '7 days'
      and type = any(${FAILURE_EVENT_TYPES})
    group by type
    order by count(*) desc, type asc`;
  // daemon.started is machine-level (org_id null — one desktop, one daemon); org-scoped
  // emits are counted too so a future multi-org daemon stays honest.
  const [counts] = await sql<{ restarts: string }[]>`
    select (select count(*) from events
            where type = 'daemon.started' and created_at > now() - interval '7 days'
              and (org_id is null or org_id = ${orgId})) as restarts`;
  return {
    clusters7d: clusters.map((c) => ({ type: c.type, count: Number(c.n) })),
    daemonRestarts7d: Number(counts!.restarts),
  };
}


async function browseGroup(sql: postgres.Sql, orgId: string): Promise<HealthReport['browse']> {
  // Browse + connector tool steps live in run.activity events; per-domain buckets by hostname in JS.
  const steps = await sql<{ tool: string; target: string | null }[]>`
    select step->>'tool' as tool, step->>'target' as target
    from events, jsonb_array_elements(payload->'steps') step
    where org_id = ${orgId} and type = 'run.activity'
      and created_at > now() - interval '30 days'
      and (step->>'tool' = 'mcp__tent-nocode-browser__browse_open'
           or step->>'tool' like 'mcp__tent-nocode-connector__%'
           or step->>'tool' like 'mcp__ext-%')`;
  let pages = 0;
  let connectors = 0;
  let externalMcp = 0;
  const byDomain = new Map<string, number>();
  for (const s of steps) {
    if (s.tool === 'mcp__tent-nocode-browser__browse_open') {
      pages += 1;
      try {
        const host = s.target ? new URL(s.target).hostname : null;
        if (host) byDomain.set(host, (byDomain.get(host) ?? 0) + 1);
      } catch { /* unparseable target — counted in pages, not per-domain */ }
    } else if (s.tool.startsWith('mcp__ext-')) {
      externalMcp += 1; // connection tool calls, audited like browse
    } else {
      connectors += 1;
    }
  }
  const topDomains = [...byDomain.entries()]
    .map(([domain, p]) => ({ domain, pages: p }))
    .sort((a, b) => b.pages - a.pages || a.domain.localeCompare(b.domain))
    .slice(0, 5);
  return { pages30d: pages, connectorCalls30d: connectors, externalMcpCalls30d: externalMcp, topDomains };
}

/** One deterministic read over the org's own record. */
export async function orgHealth(sql: postgres.Sql, orgId: string): Promise<HealthReport> {
  return {
    spend: await spendGroup(sql, orgId),
    honesty: await honestyGroup(sql, orgId),
    loop: await loopGroup(sql, orgId),
    discipline: await disciplineGroup(sql, orgId),
    errors: await errorsGroup(sql, orgId),
    browse: await browseGroup(sql, orgId),
    generatedAt: new Date().toISOString(),
  };
}
