import type { HealthReport } from '../../../shared/ipc.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import threadStyles from '../thread/thread.module.css';
import styles from './settings.module.css';

// Health section: deterministic kernel numbers read at open time plus the latest weekly note.

function Row({ label, value, flag = false, sub = false }: {
  label: string; value: string; flag?: boolean; sub?: boolean;
}) {
  return (
    <div className={sub ? `${styles.hrow} ${styles.hsub}` : styles.hrow}>
      <span className={styles.hl}>{label}</span>
      <span className={flag ? `${styles.hv} ${styles.hflag}` : styles.hv}>{value}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={styles.hh}>{title}</div>
      {children}
    </div>
  );
}

export function HealthSection({ orgId }: { orgId: string }) {
  const q = useQuery(`settings-health:${orgId}`, () => desk.orgHealth(orgId), [orgId]);

  if (q.error) {
    return <div className={threadStyles.errorText}>{q.error}</div>;
  }
  const h: HealthReport | undefined = q.data;
  if (!h) return null; // renders when the read lands

  return (
    <>
      <div className={styles.groupDesc}>
        Your own record, read at open time.
      </div>

      <Group title="spend (30d)">
        <Row label="tokens" value={h.spend.tokens30d.toLocaleString()} />
        <Row label="spend" value={`$${h.spend.usd30d.toFixed(2)}`} />
        {h.spend.topThreads.map((t) => (
          <Row
            key={t.threadId} sub
            label={t.title ?? t.threadId.slice(0, 8)}
            value={`${t.tokens.toLocaleString()} tok · $${t.usd.toFixed(2)}`}
          />
        ))}
        <Row label="grind runs (≥80% of timeout, empty outcome)" value={String(h.spend.grindRuns30d)} flag={h.spend.grindRuns30d > 0} />
        <Row label="cache hit rate" value={`${(h.spend.cacheHitRate30d * 100).toFixed(0)}%`} />
        <Row label="avg chat-turn cost" value={`${Math.round(h.spend.avgChatTurnTokens30d).toLocaleString()} eff. tokens`} />
      </Group>

      <Group title="honesty (30d)">
        <Row label="runs" value={`${h.honesty.succeededRuns30d} succeeded · ${h.honesty.failedRuns30d} failed`} />
        <Row label="honest-empty settled runs" value={String(h.honesty.honestEmptyJobs30d)} flag={h.honesty.honestEmptyJobs30d > 0} />
        <Row label="tab writes rejected" value={String(h.honesty.tabWriteRejects30d)} flag={h.honesty.tabWriteRejects30d > 0} />
      </Group>

      <Group title="loop">
        <Row label="missions" value={`${h.loop.openIntents} open · ${h.loop.parkedIntents} parked`} />
        <Row label="parked over 24h" value={String(h.loop.parkedOver24h)} flag={h.loop.parkedOver24h > 0} />
        <Row label="rescue tank exhausted" value={String(h.loop.budgetExhausted)} flag={h.loop.budgetExhausted > 0} />
        <Row label="rescue wakes (30d)" value={String(h.loop.rescueFirings30d)} />
        <Row label="cancelled missions (30d)" value={String(h.loop.cancelled30d)} />
      </Group>

      <Group title="discipline (30d)">
        <Row label="avg work-run report" value={`${h.discipline.avgReportChars30d} chars`} flag={h.discipline.avgReportChars30d > 1200} />
        <Row label="double-reporter wakes" value={String(h.discipline.doubleReporterWakes30d)} flag={h.discipline.doubleReporterWakes30d > 0} />
        <Row label="effective tokens per settled part" value={h.discipline.effPerSettledPart30d.toLocaleString('en-US')} />
      </Group>


      <Group title="reach (30d)">
        <Row label="pages browsed" value={String(h.browse.pages30d)} />
        <Row label="connector calls" value={String(h.browse.connectorCalls30d)} />
        <Row label="connection tool calls" value={String(h.browse.externalMcpCalls30d)} />
        {h.browse.topDomains.map((d) => (
          <Row key={d.domain} sub label={d.domain} value={`${d.pages} page${d.pages === 1 ? '' : 's'}`} />
        ))}
      </Group>

      <Group title="errors (7d)">
        {h.errors.clusters7d.length === 0 ? (
          <Row label="failure events" value="none" />
        ) : (
          h.errors.clusters7d.map((cl) => (
            <Row key={cl.type} sub label={cl.type} value={`×${cl.count}`} flag />
          ))
        )}
        <Row label="daemon starts" value={String(h.errors.daemonRestarts7d)} />
      </Group>

      <div className={styles.hmeta}>read {new Date(h.generatedAt).toLocaleTimeString()}</div>
    </>
  );
}
