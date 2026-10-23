import { useEffect, useState } from 'react';
import { desk } from '../../lib/desk.js';
import { navigate } from '../../lib/router.js';
import {
  TRIGGER_WHEN_KINDS, TRIGGER_WHEN_WORDS, actionOf, draftFromRow, draftReady, entryWords,
  freshTriggerDraft, specOf,
} from '../../lib/canvas/store.js';
import type { TriggerDraft } from '../../lib/canvas/store.js';
import styles from './configcard.module.css';

/** Trigger config: when/then clauses, connections, and flow entry. */

export interface TriggerMinted {
  triggerId: string;
  kind: string;
  dataset?: string;
  operation?: string;
  connectionId?: string;
  flowStep?: string;
}

export type TriggerCardMode =
  | { dress: 'create'; prefill?: { dataset?: string; operation?: string } }
  | { dress: 'edit'; triggerId: string };

export function TriggerConfig({ orgId, projectId, mode, datasets, operations, say, onMinted, onReminted }: {
  orgId: string;
  projectId: string | null;
  mode: TriggerCardMode;
  datasets: string[];
  operations: string[];
  say: (sentence: string) => void;
  onMinted: (minted: TriggerMinted) => void;
  onReminted: (minted: TriggerMinted, oldTriggerId: string) => void;
}) {
  const pid = projectId ?? undefined;
  const [draft, setDraft] = useState<TriggerDraft>(() => freshTriggerDraft(mode.dress === 'create' ? mode.prefill : undefined));
  const [baseline, setBaseline] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  /** Fire line: fired time, row count, pause reason. */
  const [fire, setFire] = useState<{ at: string | null; count: number | null; paused: string | null }>({ at: null, count: null, paused: null });
  /** A placed kind this form does not speak (rows_changed…) - pause/delete stand. */
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [datasetInputs, setDatasetInputs] = useState<string[]>([]);
  const [endpoints, setEndpoints] = useState<Array<{ token: string; label: string }>>([]);
  const [connections, setConnections] = useState<Array<{ id: string; label: string; integration: string; version: number }>>([]);
  const [doors, setDoors] = useState<Array<{ id: string; word: string; klass: string }>>([]);
  const [entries, setEntries] = useState<Array<{ id: string; word: string }>>([]);
  const [mainFlowId, setMainFlowId] = useState<string | null>(null);

  const patch = (p: Partial<TriggerDraft>): void => setDraft((d) => ({ ...d, ...p }));

  // Edit mode: prefill from stored trigger row.
  useEffect(() => {
    if (mode.dress !== 'edit') return;
    let gone = false;
    desk.listTriggers(orgId).then((rows) => {
      if (gone) return;
      const row = rows.find((t) => t.id === mode.triggerId);
      if (row === undefined) { say('that trigger is already gone'); return; }
      setEnabled(row.enabled);
      setFire({ at: row.lastFiredAt ?? null, count: row.lastFireCount ?? null, paused: row.pausedReason ?? null });
      const d = draftFromRow(row);
      if (d === null) { setUnsupported(row.kind.replace(/_/g, ' ')); return; }
      setDraft(d);
      setBaseline(JSON.stringify(d));
    }).catch(() => undefined);
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, mode.dress, mode.dress === 'edit' ? mode.triggerId : '']);

  // Tool's dataset inputs render as rows.
  useEffect(() => {
    if (draft.operation === '') { setDatasetInputs([]); return; }
    let gone = false;
    desk.operationContract(orgId, draft.operation).then((c) => {
      if (gone) return;
      setDatasetInputs(Object.entries(c?.inputs ?? {}).filter(([, d]) => d.type === 'dataset').map(([k]) => k));
    }).catch(() => setDatasetInputs([]));
    return () => { gone = true; };
  }, [orgId, draft.operation]);

  // Endpoints and connections offered where they exist.
  useEffect(() => {
    let gone = false;
    desk.integrationsWebhooksList(orgId, pid).then((rows) => {
      if (gone) return;
      setEndpoints(rows.map((r) => ({ token: r.token, label: r.label })));
      setDraft((d) => (d.endpointToken === '' ? { ...d, endpointToken: rows[0]?.token ?? '' } : d));
    }).catch(() => undefined);
    desk.integrationsList(orgId, pid).then((rows) => {
      if (gone) return;
      const live = rows.filter((r) => r.status !== 'revoked');
      setConnections(live.map((r) => ({ id: r.id, label: r.label, integration: r.integration, version: r.version })));
      setDraft((d) => (d.connectionId === '' ? { ...d, connectionId: live[0]?.id ?? '' } : d));
    }).catch(() => undefined);
    return () => { gone = true; };
  }, [orgId, pid]);

  // Working flow entry steps in plain words.
  useEffect(() => {
    let gone = false;
    void Promise.all([desk.flowsList(orgId, pid), desk.flowStepCatalog()]).then(([flows, catalog]) => {
      if (gone) return;
      const main = flows.find((f) => f.name === 'main');
      const doc = (main?.doc ?? null) as { steps?: Record<string, { kind?: string }>; edges?: Array<{ to: string }> } | null;
      const targets = new Set((doc?.edges ?? []).map((e) => e.to));
      const roots = Object.keys(doc?.steps ?? {}).filter((id) => !targets.has(id));
      setMainFlowId(main?.id ?? null);
      setEntries(entryWords(roots, (id) => doc?.steps?.[id]?.kind, catalog));
      setDraft((d) => (roots.includes(d.entry) ? d : { ...d, entry: roots[0] ?? '' }));
    }).catch(() => undefined);
    return () => { gone = true; };
  }, [orgId, pid]);

  // Connection's doors; send-class leads default.
  useEffect(() => {
    const conn = connections.find((c) => c.id === draft.connectionId);
    if (conn === undefined) { setDoors([]); return; }
    let gone = false;
    desk.integrationsCatalog().then((catalog) => {
      if (gone) return;
      const entry = catalog.find((e) => e.name === conn.integration && e.version === conn.version);
      const rows = (entry?.endpoints ?? []).map((e) => ({ id: e.id, word: e.displayName, klass: e.class }));
      setDoors(rows);
      setDraft((d) => (rows.some((r) => r.id === d.endpointId) ? d : { ...d, endpointId: (rows.find((r) => r.klass === 'send') ?? rows[0])?.id ?? '' }));
    }).catch(() => setDoors([]));
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, draft.connectionId]);

  async function mint(): Promise<void> {
    setBusy(true);
    const res = await desk.humanMintTrigger(orgId, draft.kind, specOf(draft), actionOf(draft, datasetInputs, datasets), pid);
    setBusy(false);
    if (!res.ok) { say(res.error); return; }
    const minted: TriggerMinted = {
      triggerId: res.data?.triggerId ?? '', kind: draft.kind,
      ...(draft.kind === 'dataset_threshold' ? { dataset: draft.dataset } : {}),
      ...(draft.actionKind === 'run_operation' ? { operation: draft.operation } : {}),
      ...(draft.actionKind === 'call_integration' ? { connectionId: draft.connectionId } : {}),
      ...(draft.actionKind === 'start_flow' && mainFlowId !== null ? { flowStep: `fstep:${mainFlowId}:${draft.entry}` } : {}),
    };
    if (mode.dress === 'edit') {
      await desk.deleteTrigger(orgId, mode.triggerId).catch(() => undefined);
      setBaseline(JSON.stringify(draft));
      onReminted(minted, mode.triggerId);
    } else {
      onMinted(minted);
    }
  }

  async function flipEnabled(): Promise<void> {
    if (mode.dress !== 'edit') return;
    const next = !enabled;
    setEnabled(next);
    await desk.setTriggerEnabled(orgId, mode.triggerId, next).catch(() => say('that did not land'));
  }

  const fireLine = !enabled
    ? <div className={styles.fireLine}><span className={styles.firePaused}>Paused</span>{fire.paused !== null ? <span className={styles.fireQuiet}>· {fire.paused.slice(0, 70)}</span> : null}</div>
    : fire.at !== null
      ? <div className={styles.fireLine}><span className={styles.fireNews}>Fired {fire.at.slice(11, 16)}</span>{fire.count !== null ? <span className={styles.fireQuiet}>· {fire.count === 1 ? '1 row' : `${fire.count} rows`}</span> : null}</div>
      : null;

  if (unsupported !== null) {
    return (
      <>
        <div className={styles.body}>
          <div className={styles.row}><span className={styles.lblFree}>{unsupported}</span></div>
          {fireLine}
        </div>
        <div className={styles.foot}>
          <button type="button" className={styles.verbQuiet} onClick={() => void flipEnabled()}>{enabled ? 'Pause' : 'Resume'}</button>
        </div>
      </>
    );
  }

  const dirty = baseline !== null && baseline !== JSON.stringify(draft);
  const ready = draftReady(draft);

  return (
    <>
      <div className={styles.body}>
        <div className={styles.row}>
          <span className={styles.lbl}>when</span>
          <select className={styles.select} value={draft.kind} onChange={(e) => patch({ kind: e.target.value as TriggerDraft['kind'] })}>
            {TRIGGER_WHEN_KINDS.filter((k) => k !== 'webhook_in' || endpoints.length > 0 || draft.kind === 'webhook_in')
              .map((k) => <option key={k} value={k}>{TRIGGER_WHEN_WORDS[k]}</option>)}
          </select>
        </div>
        {draft.kind === 'dataset_threshold' ? (
          <>
            <div className={styles.row}>
              <span className={styles.lbl}></span>
              <select className={styles.select} value={draft.dataset} onChange={(e) => patch({ dataset: e.target.value })}>
                {draft.dataset === '' ? <option value="">pick a table</option> : null}
                {(draft.dataset !== '' && !datasets.includes(draft.dataset) ? [draft.dataset, ...datasets] : datasets)
                  .map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <input className={`${styles.well} ${styles.wellNum}`} placeholder="column" value={draft.column} onChange={(e) => patch({ column: e.target.value })} />
            </div>
            <div className={styles.row}>
              <span className={styles.lbl}></span>
              <select className={styles.select} value={draft.op} onChange={(e) => patch({ op: e.target.value as TriggerDraft['op'] })}>
                <option value=">">is more than</option>
                <option value=">=">is at least</option>
                <option value="<">is less than</option>
                <option value="<=">is at most</option>
                <option value="==">is exactly</option>
              </select>
              <input className={`${styles.well} ${styles.wellNum}`} placeholder="value" value={draft.value} onChange={(e) => patch({ value: e.target.value })} />
            </div>
          </>
        ) : draft.kind === 'webhook_in' ? (
          <div className={styles.row}>
            <span className={styles.lbl}></span>
            <select className={styles.select} value={draft.endpointToken} onChange={(e) => patch({ endpointToken: e.target.value })}>
              {endpoints.map((ep) => <option key={ep.token} value={ep.token}>{ep.label}</option>)}
            </select>
          </div>
        ) : draft.kind === 'schedule' ? (
          <div className={styles.row}>
            <span className={styles.lbl}>at</span>
            <input className={`${styles.well} ${styles.wellNum}`} placeholder="09:00" value={draft.time} onChange={(e) => patch({ time: e.target.value })} />
          </div>
        ) : draft.kind === 'cron' ? (
          <div className={styles.row}>
            <span className={styles.lbl}></span>
            <input className={styles.well} placeholder="0 9 * * *" value={draft.cronExpr} onChange={(e) => patch({ cronExpr: e.target.value })} />
          </div>
        ) : draft.kind === 'interval' ? (
          <div className={styles.row}>
            <span className={styles.lbl}>every</span>
            <input className={`${styles.well} ${styles.wellNum}`} placeholder="30" value={draft.minutes} onChange={(e) => patch({ minutes: e.target.value })} />
            <span className={styles.lbl}>minutes</span>
          </div>
        ) : (
          <div className={styles.row}>
            <span className={styles.lbl}></span>
            <input className={styles.well} placeholder="result name (empty = any)" value={draft.outputName} onChange={(e) => patch({ outputName: e.target.value })} />
          </div>
        )}
        <div className={styles.row}>
          <span className={styles.lbl}>then</span>
          <select className={styles.select} value={draft.actionKind} onChange={(e) => patch({ actionKind: e.target.value as TriggerDraft['actionKind'] })}>
            <option value="run_operation">run a tool</option>
            {connections.length > 0 ? <option value="call_integration">send through a connection</option> : null}
            {entries.length > 0 ? <option value="start_flow">start the flow</option> : null}
          </select>
        </div>
        {draft.actionKind === 'run_operation' ? (
          <div className={styles.row}>
            <span className={styles.lbl}>run</span>
            {operations.length === 0 && draft.operation === '' ? (
              // Form offers to create missing tool.
              <button type="button" className={styles.add} onClick={() => navigate(projectId !== null ? `/code/${projectId}?draft=1` : '/code?draft=1')}>
                <span className={styles.addChip}>+</span>New tool…
              </button>
            ) : (
              <select className={styles.select} value={draft.operation} onChange={(e) => patch({ operation: e.target.value })}>
                {draft.operation === '' ? <option value="">pick a tool</option> : null}
                {(draft.operation !== '' && !operations.includes(draft.operation) ? [draft.operation, ...operations] : operations)
                  .map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
          </div>
        ) : draft.actionKind === 'start_flow' ? (
          <div className={styles.row}>
            <span className={styles.lbl}>from</span>
            <select className={styles.select} value={draft.entry} onChange={(e) => patch({ entry: e.target.value })}>
              {entries.map((s) => <option key={s.id} value={s.id}>{s.word}</option>)}
            </select>
          </div>
        ) : (
          <>
            <div className={styles.row}>
              <span className={styles.lbl}>through</span>
              <select className={styles.select} value={draft.connectionId} onChange={(e) => patch({ connectionId: e.target.value })}>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            {doors.length > 0 ? (
              <div className={styles.row}>
                <span className={styles.lbl}>door</span>
                <select className={styles.select} value={draft.endpointId} onChange={(e) => patch({ endpointId: e.target.value })}>
                  {doors.map((d) => <option key={d.id} value={d.id}>{d.word}</option>)}
                </select>
              </div>
            ) : null}
          </>
        )}
        {/* Tool's dataset inputs; watched table pre-selected. */}
        {draft.actionKind === 'run_operation' ? datasetInputs.map((key) => (
          <div key={key} className={styles.row}>
            <span className={styles.lbl}>give it</span>
            <select
              className={styles.select}
              value={draft.feed[key] ?? (draft.kind === 'dataset_threshold' ? draft.dataset : datasets[0] ?? '')}
              onChange={(e) => patch({ feed: { ...draft.feed, [key]: e.target.value } })}
            >
              {datasets.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )) : null}
        {mode.dress === 'edit' ? fireLine : null}
      </div>
      <div className={styles.foot}>
        {mode.dress === 'create' ? (
          <button type="button" className={`${styles.verb} ${styles.verbGold}`} disabled={!ready || busy} onClick={() => void mint()}>
            Start watching
          </button>
        ) : (
          <>
            {dirty && ready ? (
              <button type="button" className={styles.verb} disabled={busy} onClick={() => void mint()}>Save</button>
            ) : null}
            <button type="button" className={styles.verbQuiet} onClick={() => void flipEnabled()}>{enabled ? 'Pause' : 'Resume'}</button>
          </>
        )}
      </div>
    </>
  );
}
