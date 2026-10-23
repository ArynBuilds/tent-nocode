import { useEffect, useState } from 'react';
import { desk } from '../../lib/desk.js';
import styles from './entered.module.css';

// Who sees a table's rows: the one behavior setting a Table carries, shown beside its rows in app projects.

type Grain = 'own' | 'shared' | 'submitted' | 'app';

const GRAIN_WORDS: Record<Grain, string> = {
  own: 'Each person sees their own rows',
  shared: 'Everyone shares the rows',
  submitted: 'People submit, the owner sees all',
  app: "The app's own rows, no user writes",
};

export function DatasetGrain({ orgId, projectId, dataset, say }: {
  orgId: string; projectId: string | null; dataset: string; say: (s: string) => void;
}) {
  const [grain, setGrain] = useState<Grain | null>(null);
  const [projectKind, setProjectKind] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    desk.humanDatasetGrain(orgId, dataset, projectId).then((g) => { if (!gone) setGrain(g); }).catch(() => undefined);
    desk.listProjects(orgId).then((ps) => { if (!gone) setProjectKind(ps.find((p) => p.id === projectId)?.kind ?? null); }).catch(() => undefined);
    return () => { gone = true; };
  }, [orgId, projectId, dataset]);
  if (projectKind !== 'app' || grain === null) return null;
  return (
    <label className={styles.grain}>
      <span className={styles.grainWord}>Who sees the rows</span>
      <select
        className={styles.grainSelect}
        value={grain}
        onChange={(e) => {
          const next = e.target.value as Grain;
          void desk.humanSetDatasetGrain(orgId, dataset, projectId, next).then((r) => {
            if (!r.ok) say(r.error); else setGrain(next);
          });
        }}
      >
        {(Object.keys(GRAIN_WORDS) as Grain[]).map((g) => <option key={g} value={g}>{GRAIN_WORDS[g]}</option>)}
      </select>
    </label>
  );
}
