import { useEffect, useState } from 'react';
import type { RunRow } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { subscribeLive } from '../../lib/live.js';
import { useOrg } from '../../lib/OrgContext.js';
import styles from './shell.module.css';

// Run with no heartbeat for SILENT_MS is gone silent.
const SILENT_MS = 120_000;

// Derives anomalies: runs silent >SILENT_MS. heartbeatAt=null is not silent (no first heartbeat yet).
export function deriveAnomalies(
  runs: Array<Pick<RunRow, 'status' | 'heartbeatAt'>>,
  now: number,
): string[] {
  const anomalies: string[] = [];

  const silentCount = runs.filter(
    (r) => r.status === 'running' && r.heartbeatAt !== null && now - Date.parse(r.heartbeatAt) > SILENT_MS,
  ).length;
  if (silentCount > 0) {
    anomalies.push(`${silentCount} run${silentCount === 1 ? '' : 's'} silent >2m`);
  }

  return anomalies;
}

// Amber pill: renders anomalies or nothing; updates on live notifies + 15s poll.
export function AnomalyStrip() {
  const { orgId } = useOrg();
  const [anomalies, setAnomalies] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    const refresh = (): void => {
      desk.runsOverview(orgId)
        .then((overview) => {
          if (cancelled) return;
          const runs = overview.runningRuns.map((r) => ({ status: 'running' as const, heartbeatAt: r.heartbeatAt }));
          setAnomalies(deriveAnomalies(runs, Date.now()));
        })
        .catch(() => undefined);
    };

    refresh();
    const poll = setInterval(refresh, 15_000);
    const unsubscribe = subscribeLive((event) => {
      if ('kind' in event || event.table !== 'runs') return;
      if (event.orgId !== null && event.orgId !== orgId) return;
      refresh();
    });

    return () => {
      cancelled = true;
      clearInterval(poll);
      unsubscribe();
    };
  }, [orgId]);

  if (anomalies.length === 0) return null;

  return (
    <span className={styles.anomalyFloat}>
      <span className={styles.dot} />
      {anomalies.join(' · ')}
    </span>
  );
}
