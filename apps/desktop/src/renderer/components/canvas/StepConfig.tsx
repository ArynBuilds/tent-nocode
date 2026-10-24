import { useEffect, useState } from 'react';
import type { ConditionOp, FlowCondition } from '@nodeloom/core';
import { desk } from '../../lib/desk.js';
import {
  ALL_CONDITION_OPS, CONDITION_WORDS, NO_RIGHT_OPS, cardControlsFor, cardParamWord,
  coerceParam, dropRule, inputSourceFor, pillField, setRule, withRule,
} from '../../lib/canvas/store.js';
import type { CardControl, StepDefWire } from '../../lib/canvas/store.js';
import styles from './configcard.module.css';

/** Step config: declared params, upstream fields, and last-run sample. */

export function StepConfig({ orgId, projectId, flowId, stepId, tables, say, onVerb, onGone }: {
  orgId: string;
  projectId: string | null;
  flowId: string;
  stepId: string;
  tables: string[];
  say: (sentence: string) => void;
  onVerb: (door: 'test-step' | 'toggle-step') => void;
  onGone: () => void;
}) {
  const [def, setDef] = useState<StepDefWire | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [disabled, setDisabled] = useState(false);
  const [fields, setFields] = useState<string[]>([]);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [sample, setSample] = useState<{ line: string; count: number } | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [lastWord, setLastWord] = useState<string | null>(null);

  // Load def and params; input fields from upstream; sample from last run.
  useEffect(() => {
    let gone = false;
    void (async () => {
      const [catalog, flows] = await Promise.all([
        desk.flowStepCatalog().catch(() => []),
        desk.flowsList(orgId, projectId ?? undefined).catch(() => []),
      ]);
      if (gone) return;
      const doc = (flows.find((f) => f.id === flowId)?.doc ?? null) as
        { steps?: Record<string, { kind?: string; params?: Record<string, unknown>; disabled?: boolean }>; edges?: Array<{ from: string; to: string; order?: number }> } | null;
      const step = doc?.steps?.[stepId];
      if (step === undefined) { onGone(); return; }
      setDef(catalog.find((d) => d.kind === step.kind) ?? null);
      setParams(step.params ?? {});
      setDisabled(step.disabled === true);
      const src = inputSourceFor(doc, stepId);
      setUpstream(src.upstream);
      if (src.table !== null) {
        const brief = await desk.datasetBrief(orgId, src.table, projectId ?? undefined).catch(() => null);
        if (!gone && brief !== null) setFields(brief.columns.map((c) => c.key));
      }
      const s = await desk.flowsStepInputSample(orgId, flowId, stepId).catch(() => null);
      if (!gone && s !== null && s.items.length > 0) {
        setFields((prev) => [...prev, ...s.fields.filter((f) => !prev.includes(f))]);
        // Machine values (ids, uuids) never speak on the card sample.
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const spoken = Object.entries(s.items[0]!)
          .filter(([k, v]) => !k.startsWith('_') && !uuidRe.test(String(v)))
          .map(([, v]) => String(v));
        setSample({ line: spoken.join(' · ').slice(0, 90), count: s.items.length });
      }
      const runs = await desk.flowsLastRun(orgId, projectId ?? '').catch(() => []);
      if (gone) return;
      const run = runs.find((r) => r.flowId === flowId);
      const ports = run?.stepCounts[stepId];
      if (run !== undefined && ports !== undefined) {
        const n = Object.values(ports).reduce((a, c) => a + c, 0);
        setLastWord(`${n === 1 ? '1 item' : `${n} items`} · ${run.createdAt.slice(11, 16)}`);
      }
    })();
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, flowId, stepId]);

  // Table param's columns from schema.
  const tableValue = def?.params.some((p) => p.name === 'table') === true && typeof params['table'] === 'string' ? params['table'] : null;
  useEffect(() => {
    setColumns([]);
    if (tableValue === null || tableValue === '') return;
    let gone = false;
    desk.datasetBrief(orgId, tableValue, projectId ?? undefined)
      .then((b) => { if (!gone) setColumns(b.columns.map((c) => c.key)); })
      .catch(() => undefined);
    return () => { gone = true; };
  }, [orgId, projectId, tableValue]);

  const controls = def !== null ? cardControlsFor(def, params) : [];
  const conditionControl = controls.find((c): c is Extract<CardControl, { control: 'condition' }> => c.control === 'condition');

  function write(patch: Record<string, unknown>): void {
    setParams((p) => ({ ...p, ...patch }));
    void desk.flowsSetStepParams(orgId, flowId, stepId, patch).then((r) => { if (!r.ok) say(r.error); });
  }
  const writeCond = (name: string, c: FlowCondition | null): void => write({ [name]: c });
  const fieldOptions = (current: string): string[] => (current !== '' && !fields.includes(current) ? [current, ...fields] : fields);

  return (
    <>
      <div className={styles.body}>
        {controls.map((c) => {
          if (c.control === 'condition') {
            const cond = c.value;
            return (
              <div key={c.name} style={{ display: 'contents' }}>
                <div className={styles.row}><span className={styles.lblFree}>{cardParamWord(c.name)}</span></div>
                {(cond?.rules ?? []).map((r, i) => (
                  <div key={i} className={styles.row}>
                    <select
                      className={styles.pillSelect} value={pillField(r.left)} aria-label="field"
                      onChange={(e) => writeCond(c.name, setRule(cond!, i, { field: e.target.value }, upstream))}
                    >
                      {fieldOptions(pillField(r.left)).map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select
                      className={styles.select} value={r.op} aria-label="check"
                      onChange={(e) => writeCond(c.name, setRule(cond!, i, { op: e.target.value as ConditionOp }, upstream))}
                    >
                      {ALL_CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_WORDS[op]}</option>)}
                    </select>
                    {!NO_RIGHT_OPS.has(r.op) ? (
                      <input
                        className={`${styles.well} ${styles.wellNum}`} aria-label="value"
                        defaultValue={r.right === undefined ? '' : String(r.right)}
                        onBlur={(e) => writeCond(c.name, setRule(cond!, i, { right: e.target.value }, upstream))}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                    ) : null}
                    <button type="button" className={styles.ruleX} aria-label="Remove check" onClick={() => writeCond(c.name, dropRule(cond!, i))}>×</button>
                  </div>
                ))}
                <div className={styles.row}>
                  <span className={styles.lbl}>{cond !== null && cond.rules.length > 0 ? 'and' : ''}</span>
                  <button
                    type="button" className={styles.add}
                    onClick={() => writeCond(c.name, withRule(cond, fields[0] ?? 'value', upstream))}
                  >
                    <span className={styles.addChip}>+</span>Add…
                  </button>
                </div>
              </div>
            );
          }
          if (c.control === 'table') {
            const rows = c.value !== '' && !tables.includes(c.value) ? [c.value, ...tables] : tables;
            return (
              <div key={c.name} className={styles.row}>
                <span className={styles.lbl}>{cardParamWord(c.name)}</span>
                <select className={styles.select} value={c.value} onChange={(e) => write({ [c.name]: e.target.value })}>
                  {c.value === '' ? <option value="">Pick a table</option> : null}
                  {rows.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            );
          }
          if (c.control === 'enum') {
            return (
              <div key={c.name} className={styles.row}>
                <span className={styles.lbl}>{cardParamWord(c.name)}</span>
                <select className={styles.select} value={c.value} onChange={(e) => write({ [c.name]: e.target.value })}>
                  {c.choices.map((ch) => <option key={ch} value={ch}>{ch.replace(/[-_]+/g, ' ')}</option>)}
                </select>
              </div>
            );
          }
          if (c.control === 'fieldpick') {
            // Known upstream fields pick; unknown territory falls back to typing.
            return fields.length > 0 ? (
              <div key={c.name} className={styles.row}>
                <span className={styles.lbl}>{cardParamWord(c.name)}</span>
                <select className={styles.select} value={c.value} onChange={(e) => write({ [c.name]: e.target.value })}>
                  {c.value === '' ? <option value="">Pick a field</option> : null}
                  {fieldOptions(c.value).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            ) : (
              <div key={c.name} className={styles.row}>
                <span className={styles.lbl}>{cardParamWord(c.name)}</span>
                <input
                  className={styles.well} defaultValue={c.value}
                  onBlur={(e) => write({ [c.name]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </div>
            );
          }
          if (c.control === 'pairs') {
            // Name→value rows for object-map params; wire-landed pill entries survive untouched.
            const writePairs = (pairs: Array<[string, string]>): void => {
              const existing = typeof params[c.name] === 'object' && params[c.name] !== null && !Array.isArray(params[c.name])
                ? (params[c.name] as Record<string, unknown>) : {};
              const kept = Object.fromEntries(Object.entries(existing).filter(([, v]) => typeof v !== 'string'));
              write({ [c.name]: { ...kept, ...Object.fromEntries(pairs.filter(([k]) => k !== '')) } });
            };
            return (
              <div key={c.name} style={{ display: 'contents' }}>
                <div className={styles.row}><span className={styles.lblFree}>{cardParamWord(c.name)}</span></div>
                {c.value.map(([k, v], i) => (
                  <div key={i} className={styles.row}>
                    <input
                      className={`${styles.well} ${styles.wellNum}`} aria-label="name" defaultValue={k}
                      onBlur={(e) => writePairs(c.value.map((p, n) => (n === i ? [e.target.value.trim(), p[1]] : p)))}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    <input
                      className={`${styles.well} ${styles.wellNum}`} aria-label="value" defaultValue={v}
                      onBlur={(e) => writePairs(c.value.map((p, n) => (n === i ? [p[0], e.target.value] : p)))}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    <button type="button" className={styles.ruleX} aria-label="Remove" onClick={() => writePairs(c.value.filter((_, n) => n !== i))}>×</button>
                  </div>
                ))}
                <div className={styles.row}>
                  <span className={styles.lbl}></span>
                  <button type="button" className={styles.add} onClick={() => writePairs([...c.value, [fields.find((f) => !c.value.some(([k]) => k === f)) ?? '', '']])}>
                    <span className={styles.addChip}>+</span>Add…
                  </button>
                </div>
              </div>
            );
          }
          if (c.control === 'toggle') {
            return (
              <div key={c.name} className={styles.row}>
                <span className={styles.lbl}>{cardParamWord(c.name)}</span>
                <button type="button" className={styles.well} onClick={() => write({ [c.name]: !c.value })}>
                  {c.value ? 'yes' : 'no'}
                </button>
              </div>
            );
          }
          return (
            <div key={c.name} className={styles.row}>
              <span className={styles.lbl}>{cardParamWord(c.name)}</span>
              <input
                className={`${styles.well} ${c.control === 'number' ? styles.wellNum : ''}`}
                defaultValue={c.control === 'number' ? (c.value === null ? '' : String(c.value)) : c.value}
                onBlur={(e) => write({ [c.name]: coerceParam(c.control, e.target.value) })}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            </div>
          );
        })}
      </div>
      {conditionControl !== undefined && fields.length > 0 ? (
        <div className={styles.strip}>
          <div className={styles.stripHead}>{sample !== null ? `last run · ${sample.count === 1 ? '1 item' : `${sample.count} items`}` : 'fields'}</div>
          <div className={styles.chips}>
            {fields.map((f) => (
              <button
                key={f} type="button" className={styles.pill} title={`Add a check on ${f}`}
                onClick={() => writeCond(conditionControl.name, withRule(conditionControl.value, f, upstream))}
              >
                {f}
              </button>
            ))}
          </div>
          {sample !== null ? <div className={styles.sample}>{sample.line}</div> : null}
        </div>
      ) : columns.length > 0 ? (
        <div className={styles.strip}>
          <div className={styles.stripHead}>columns</div>
          <div className={styles.chips}>{columns.map((f) => <span key={f} className={styles.pill}>{f}</span>)}</div>
        </div>
      ) : null}
      <div className={styles.foot}>
        <button type="button" className={styles.verb} onClick={() => onVerb('test-step')}>Test</button>
        <button type="button" className={styles.verbQuiet} onClick={() => { setDisabled((d) => !d); onVerb('toggle-step'); }}>
          {disabled ? 'Switch on' : 'Switch off'}
        </button>
        {lastWord !== null ? <span className={styles.lastWord}>{lastWord}</span> : null}
      </div>
    </>
  );
}

/** Step def's display word; fallback when label is empty. */
export function useStepWord(orgId: string, flowId: string, stepId: string, label: string): string {
  const [word, setWord] = useState(label);
  useEffect(() => {
    if (label !== '') { setWord(label); return; }
    let gone = false;
    void Promise.all([desk.flowStepCatalog().catch(() => []), desk.flowsList(orgId).catch(() => [])]).then(([catalog, flows]) => {
      if (gone) return;
      const doc = (flows.find((f) => f.id === flowId)?.doc ?? null) as { steps?: Record<string, { kind?: string }> } | null;
      const kind = doc?.steps?.[stepId]?.kind;
      setWord(catalog.find((c) => c.kind === kind)?.displayName ?? 'Step');
    });
    return () => { gone = true; };
  }, [orgId, flowId, stepId, label]);
  return word;
}
