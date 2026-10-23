// Pure wiring logic: wire compatibility checks, pair compilers, and plain-sentence refusals from node contracts.

import { citizenPhrase, citizenWord, legalTargets, portRule } from './nodeContract.js';
import type { CitizenKind } from './nodeContract.js';

export type RowSchema = Record<string, 'string' | 'number' | 'boolean'>;

export interface OpContractLite {
  inputs: Record<string, { type: 'array' | 'raster' | 'dataset' | 'param' | 'file'; description: string; valueType?: string }>;
  /** 'dataset' outputs are table rows; datasetFrom targets are dispatch-named, never wire-bindable. */
  outputs: Record<string, { kind: 'array' | 'raster' | 'dataset'; description: string; dataset?: string; key?: string; datasetFrom?: string }>;
}

/** Prettifies a column key for display; a per-column override wins; the key itself never renames. */
export function prettifyColumn(key: string, overrides?: Record<string, string> | null): string {
  const override = overrides?.[key];
  if (override !== undefined && override !== '') return override;
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words.length === 0 ? key : words[0]!.toUpperCase() + words.slice(1);
}

// ---- Column self-description ----------------------------------------------------------

export interface ColumnStats {
  type: 'string' | 'number' | 'boolean';
  /** numbers */
  min?: number | null;
  max?: number | null;
  /** strings */
  distinct?: number | null;
  sample?: string[];
  /** ISO-date-looking strings */
  dateMin?: string | null;
  dateMax?: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Builds a one-line plain-words description of a column from its stats. */
export function columnSentence(displayName: string, stats: ColumnStats): string {
  if (stats.type === 'number') {
    if (stats.min != null && stats.max != null) {
      return `${displayName} — a number between ${trimNum(stats.min)} and ${trimNum(stats.max)}`;
    }
    return `${displayName} — a number`;
  }
  if (stats.type === 'boolean') return `${displayName} — yes or no`;
  if (stats.dateMin != null && stats.dateMax != null) {
    return `${displayName} — dates from ${monthYear(stats.dateMin)} to ${monthYear(stats.dateMax)}`;
  }
  if (stats.distinct != null && stats.distinct > 0 && stats.distinct <= 12) {
    return `${displayName} — one of ${stats.distinct} words`;
  }
  return `${displayName} — text`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

// ---- The tool sentence ----------------------------------------------------------------

/** Builds a "takes X · gives Y" sentence mechanically from a tool's io contract. */
export function toolSentence(contract: OpContractLite, display?: Record<string, string> | null): string {
  const ins = Object.entries(contract.inputs);
  const outs = Object.entries(contract.outputs);
  const takes = ins.length === 0 ? 'takes nothing' : `takes ${ins.map(([name, d]) => {
    if (d.type === 'dataset') return `a table (${prettifyColumn(name, display)})`;
    if (d.type === 'param') return `${prettifyColumn(name, display)} (${d.valueType ?? 'value'})`;
    return `${d.type === 'array' ? 'an array' : 'an image'} (${prettifyColumn(name, display)})`;
  }).join(' + ')}`;
  const gives = outs.length === 0 ? 'gives nothing' : `gives ${outs.map(([name, o]) =>
    `${o.kind === 'raster' ? 'an image' : o.kind === 'dataset' ? 'rows for a table' : 'a result'} (${prettifyColumn(name, display)})`).join(' + ')}`;
  return `${takes} · ${gives}`;
}

// ---- The wire table: legality lives in nodeContract.ts; this file compiles each legal pair to its write.

export type PortKind = CitizenKind;

export type WireCompile =
  | { write: 'binding'; sentence: string }
  | { write: 'op-input'; input: string; sentence: string }
  | { write: 'chain'; sentence: string }
  | { write: 'trigger-source'; sentence: string }
  | { write: 'trigger-action'; sentence: string }
  /** The dotted permission wire is the grant; deleting revokes. */
  | { write: 'grant'; sentence: string }
  /** Frame-to-frame nav wire. */
  | { write: 'nav'; sentence: string }
  /** Operation → Table write-back binding on the named rows output. */
  | { write: 'write-back'; output: string; sentence: string }
  /** Result → App/Website binding plus viewer. */
  | { write: 'result-binding'; sentence: string }
  /** Step → step flow edge. */
  | { write: 'step-wire'; sentence: string }
  | { write: 'trigger-start-flow'; sentence: string }
  | { write: 'table-to-step'; sentence: string }
  | { write: 'step-to-tool'; sentence: string }
  | { write: 'tool-to-step'; sentence: string };

export type WireVerdict = { ok: true; compile: WireCompile } | { ok: false; sentence: string };

export interface WireEnd {
  kind: PortKind;
  label: string;
  /** dataset ends */
  rowSchema?: RowSchema;
  /** operation ends */
  contract?: OpContractLite;
}

/** Builds a refusal sentence that also names what the source CAN connect to. */
export function refusalSentence(sourceKind: string, targetKind: string): string {
  const no = `${citizenPhrase(sourceKind)} doesn't connect to ${citizenPhrase(targetKind)}`;
  if (sourceKind === 'step' && targetKind === 'dataset') {
    return `${no} — a Save rows step saves items into a table (pick the table on its card)`;
  }
  const targets = legalTargets(sourceKind).map((k) => citizenPhrase(k));
  if (targets.length === 0) return `${no} — ${citizenWord(sourceKind)} takes no wires`;
  const list = targets.length === 1 ? targets[0]! : `${targets.slice(0, -1).join(', ')} or ${targets[targets.length - 1]!}`;
  return `${no} — it connects to ${list}`;
}

/** Checks wire compatibility from the declared contracts and compiles the legal pair. */
export function checkWire(source: WireEnd, target: WireEnd): WireVerdict {
  const rule = portRule(source.kind, target.kind);
  if (rule === null) {
    return { ok: false, sentence: refusalSentence(source.kind, target.kind) };
  }
  switch (rule.write) {
    // Table → App: a binding (setSceneContracts)
    case 'binding':
      return { ok: true, compile: { write: 'binding', sentence: `${source.label} shows on ${target.label}` } };
    // Table → Tool: an input mapping on a dispatch (the tool must take a table)
    case 'op-input': {
      const inputs = Object.entries(target.contract?.inputs ?? {});
      const slot = inputs.find(([, d]) => d.type === 'dataset');
      if (!slot) {
        const speaks = target.contract ? toolSentence(target.contract) : 'its contract is unknown';
        return { ok: false, sentence: `${target.label} takes no table — it ${speaks}` };
      }
      return { ok: true, compile: { write: 'op-input', input: slot[0], sentence: `${source.label} feeds ${target.label}` } };
    }
    // Result → Tool: a reactive chain row
    case 'chain': {
      const inputs = Object.entries(target.contract?.inputs ?? {});
      const slot = inputs.find(([, d]) => d.type === 'array' || d.type === 'raster');
      if (!slot) {
        return { ok: false, sentence: `${target.label} takes no result — it ${target.contract ? toolSentence(target.contract) : 'declares no array or image input'}` };
      }
      return { ok: true, compile: { write: 'chain', sentence: `${target.label} re-runs when ${source.label} changes` } };
    }
    // Table/Result → Watcher: a trigger source
    case 'trigger-source':
      return { ok: true, compile: { write: 'trigger-source', sentence: `${target.label} watches ${source.label}` } };
    // Watcher → Tool/Connection: the trigger's action · App → Tool: a declared-action rule.
    case 'trigger-action':
      if (source.kind === 'trigger' && target.kind === 'integration') {
        return { ok: true, compile: { write: 'trigger-action', sentence: `${source.label} sends through ${target.label}` } };
      }
      return source.kind === 'trigger'
        ? { ok: true, compile: { write: 'trigger-action', sentence: `${source.label} runs ${target.label}` } }
        : { ok: true, compile: { write: 'trigger-action', sentence: `a button on ${source.label} runs ${target.label}` } };
    // Assistant → Table: the dotted permission wire IS the grant.
    case 'grant':
      return { ok: true, compile: { write: 'grant', sentence: `${source.label} may edit ${target.label}` } };
    // Frame → Frame: the flow wire writes the existing nav declaration (R3 draws it).
    case 'nav':
      return { ok: true, compile: { write: 'nav', sentence: `${source.label} leads to ${target.label}` } };
    // Result → App/Website: state never refuses; the drop lands the binding.
    case 'result-binding':
      return { ok: true, compile: { write: 'result-binding', sentence: `${source.label} shows on ${target.label}` } };
    // Step → Step: the flow edge — explicit order, never geometry.
    case 'step-wire':
      return { ok: true, compile: { write: 'step-wire', sentence: `${source.label} then ${target.label}` } };
    // Items-lane pairs always connect — no guards inside the lane.
    case 'trigger-start-flow':
      return { ok: true, compile: { write: 'trigger-start-flow', sentence: `${source.label} starts the flow at ${target.label}` } };
    case 'table-to-step':
      return { ok: true, compile: { write: 'table-to-step', sentence: `${source.label} feeds ${target.label}` } };
    case 'step-to-tool':
      return { ok: true, compile: { write: 'step-to-tool', sentence: `${source.label} then ${target.label}` } };
    case 'tool-to-step':
      return { ok: true, compile: { write: 'tool-to-step', sentence: `${source.label} then ${target.label}` } };
    // Operation → Table: the tool must produce rows — a dataset-kind output not dispatch-named.
    case 'write-back': {
      const outs = Object.entries(source.contract?.outputs ?? {});
      const slot = outs.find(([, o]) => o.kind === 'dataset' && o.datasetFrom === undefined);
      if (!slot) {
        return { ok: false, sentence: `${source.label} produces no table rows — its outputs are arrays or images` };
      }
      return { ok: true, compile: { write: 'write-back', output: slot[0], sentence: `${source.label} updates ${target.label}` } };
    }
  }
}
