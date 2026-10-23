import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { requireScene } from '../scenes/store.js';
import { setSceneContracts } from '../scenes/actions.js';

// Declared-action human doors: thin evented wrappers over the existing walls, actor user.

const ACTOR = 'user';

/** jsonb normalizes key order — a duplicate check compares CANONICAL shapes. */
const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
};
const canon = (v: unknown): string => JSON.stringify(sortKeys(v));

/** Merges a wire's declared action onto the same-named action: rules append (cap 4, exact duplicates no-op), params union with incoming winning per key. */
export async function setAction(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; action: unknown; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const named = input.action as { name?: unknown };
  if (typeof named?.name !== 'string' || named.name === '') return { ok: false, errors: ['action: needs a name'] };
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const [row] = await sql<{ bindings: unknown; actions: unknown }[]>`
    select bindings, actions from scenes where id = ${scene.id}`;
  const existing = Array.isArray(row?.actions) ? (row!.actions as Array<Record<string, unknown>>) : [];
  const prior = existing.find((a) => a?.['name'] === named.name);
  const replaced: string[] = [];
  let next: unknown[];
  if (prior === undefined) {
    // A null fires on a fresh declaration means "off" — strip it; the schema knows presence or absence alone.
    const fresh = { ...(input.action as Record<string, unknown>) };
    if ('fires' in fresh && (fresh['fires'] === null || fresh['fires'] === undefined)) delete fresh['fires'];
    next = [...existing, fresh];
  } else {
    const incoming = input.action as Record<string, unknown>;
    const incomingRules = Array.isArray(incoming['rules']) ? (incoming['rules'] as unknown[]) : [];
    const oldRules = Array.isArray(prior['rules']) ? (prior['rules'] as unknown[]) : [];
    // An incoming start_flow wire evicts prior append_row rules on this action in the same write.
    const bringsStartFlow = incomingRules.some((r) =>
      r !== null && typeof r === 'object' && (r as Record<string, unknown>)['rule'] === 'start_flow');
    const keptRules = bringsStartFlow
      ? oldRules.filter((o) => !(o !== null && typeof o === 'object' && (o as Record<string, unknown>)['rule'] === 'append_row'))
      : oldRules;
    if (keptRules.length < oldRules.length) replaced.push('append_row');
    const freshRules = incomingRules.filter((r) => !keptRules.some((o) => canon(o) === canon(r)));
    if (keptRules.length + freshRules.length > 4) {
      return { ok: false, errors: [`'${named.name}' already does ${keptRules.length} things — a button holds four at most; remove one of its wires first`] };
    }
    // A present `fires` key wins whole (null clears it); an absent key keeps the prior declaration.
    const firesTouched = 'fires' in incoming && canon(incoming['fires'] ?? null) !== canon(prior['fires'] ?? null);
    if (freshRules.length === 0 && replaced.length === 0 && !firesTouched) return { ok: true }; // the same wire twice lands nothing
    const merged: Record<string, unknown> = {
      ...prior,
      params: { ...(prior['params'] as Record<string, unknown> ?? {}), ...(incoming['params'] as Record<string, unknown> ?? {}) },
      rules: [...keptRules, ...freshRules],
    };
    if ('fires' in incoming) {
      if (incoming['fires'] === null || incoming['fires'] === undefined) delete merged['fires'];
      else merged['fires'] = incoming['fires'];
    }
    next = [...existing.filter((a) => a?.['name'] !== named.name), merged];
  }
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: row?.bindings ?? [], actions: next,
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_set',
      payload: {
        sceneSlug: input.sceneSlug, action: named.name, by: input.by,
        // The eviction is named on the record — silence never removes a wire.
        ...(replaced.length > 0 ? { replaced } : {}),
      },
    });
  }
  return res;
}

/** Each rule kind's value map — where its field mappings live. */
const RULE_VALUE_MAP: Record<string, string> = {
  append_row: 'row', update_row: 'set', action: 'with',
};

/** The shared action+rule lookup for the mapping doors. */
async function loadActionRule(
  sql: postgres.Sql, orgId: string, sceneSlug: string, actionName: string, ruleIndex: number,
): Promise<
  | { ok: true; sceneId: string; bindings: unknown; existing: Array<Record<string, unknown>>; prior: Record<string, unknown>; rule: Record<string, unknown>; mapKey: string }
  | { ok: false; errors: string[] }
> {
  const scene = await requireScene(sql, orgId, sceneSlug);
  const [row] = await sql<{ bindings: unknown; actions: unknown }[]>`
    select bindings, actions from scenes where id = ${scene.id}`;
  const existing = Array.isArray(row?.actions) ? (row!.actions as Array<Record<string, unknown>>) : [];
  const prior = existing.find((a) => a?.['name'] === actionName);
  if (prior === undefined) return { ok: false, errors: [`no action named '${actionName}' on this screen`] };
  const rules = Array.isArray(prior['rules']) ? (prior['rules'] as Array<Record<string, unknown>>) : [];
  const rule = Number.isInteger(ruleIndex) && ruleIndex >= 0 ? rules[ruleIndex] : undefined;
  if (rule === undefined) return { ok: false, errors: ['that wire is already gone — the map catches up in a beat'] };
  const mapKey = RULE_VALUE_MAP[typeof rule['rule'] === 'string' ? (rule['rule'] as string) : ''];
  if (mapKey === undefined) return { ok: false, errors: ['that rule takes no fields'] };
  return { ok: true, sceneId: scene.id, bindings: row?.bindings ?? [], existing, prior, rule, mapKey };
}

/** Writes one rule field's mapping; `ensureParam` adds the action param the mapping references. */
export async function mapActionRuleParam(
  sql: postgres.Sql,
  input: {
    orgId: string; sceneSlug: string; action: string; rule: number; key: string; value: unknown;
    ensureParam?: { name: string; type: 'string' | 'number' | 'boolean' | 'json'; description: string };
    by: string;
  },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const found = await loadActionRule(sql, input.orgId, input.sceneSlug, input.action, input.rule);
  if (!found.ok) return found;
  const { existing, prior, rule, mapKey } = found;
  const oldMap = typeof rule[mapKey] === 'object' && rule[mapKey] !== null && !Array.isArray(rule[mapKey])
    ? (rule[mapKey] as Record<string, unknown>) : {};
  const nextRule = { ...rule, [mapKey]: { ...oldMap, [input.key]: input.value } };
  const rules = (prior['rules'] as unknown[]).map((r, i) => (i === input.rule ? nextRule : r));
  const params = input.ensureParam !== undefined && !(input.ensureParam.name in (prior['params'] as Record<string, unknown> ?? {}))
    ? {
      ...(prior['params'] as Record<string, unknown> ?? {}),
      [input.ensureParam.name]: { type: input.ensureParam.type, description: input.ensureParam.description, source: 'user' },
    }
    : prior['params'];
  const next = existing.map((a) => (a?.['name'] === input.action ? { ...a, params, rules } : a));
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: found.bindings, actions: next,
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_set',
      payload: { sceneSlug: input.sceneSlug, action: input.action, rule: input.rule, param: input.key, by: input.by },
    });
  }
  return res;
}

/** Unmaps exactly one field; the rule stands whole. */
export async function unmapActionRuleParam(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; action: string; rule: number; key: string; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const found = await loadActionRule(sql, input.orgId, input.sceneSlug, input.action, input.rule);
  if (!found.ok) return found;
  const { existing, prior, rule, mapKey } = found;
  const oldMap = typeof rule[mapKey] === 'object' && rule[mapKey] !== null && !Array.isArray(rule[mapKey])
    ? (rule[mapKey] as Record<string, unknown>) : {};
  if (!(input.key in oldMap)) return { ok: false, errors: ['that wire is already gone — the map catches up in a beat'] };
  const rest = { ...oldMap };
  delete rest[input.key];
  const nextRule = { ...rule, [mapKey]: rest };
  const rules = (prior['rules'] as unknown[]).map((r, i) => (i === input.rule ? nextRule : r));
  const next = existing.map((a) => (a?.['name'] === input.action ? { ...a, rules } : a));
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: found.bindings, actions: next,
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_removed',
      payload: { sceneSlug: input.sceneSlug, action: input.action, rule: input.rule, param: input.key, by: input.by },
    });
  }
  return res;
}

/** Removes a whole action declaration, its wires with it. */
export async function removeAction(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; action: string; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const [row] = await sql<{ bindings: unknown; actions: unknown }[]>`
    select bindings, actions from scenes where id = ${scene.id}`;
  const existing = Array.isArray(row?.actions) ? (row!.actions as Array<Record<string, unknown>>) : [];
  if (!existing.some((a) => a?.['name'] === input.action)) {
    return { ok: false, errors: [`no action named '${input.action}' on this screen`] };
  }
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: row?.bindings ?? [],
    actions: existing.filter((a) => a?.['name'] !== input.action),
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_removed',
      payload: { sceneSlug: input.sceneSlug, action: input.action, whole: true, by: input.by },
    });
  }
  return res;
}

/** Removes one rule by index; the last rule leaving takes the whole action with it. */
export async function removeActionRule(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; action: string; rule: number; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const [row] = await sql<{ bindings: unknown; actions: unknown }[]>`
    select bindings, actions from scenes where id = ${scene.id}`;
  const existing = Array.isArray(row?.actions) ? (row!.actions as Array<Record<string, unknown>>) : [];
  const prior = existing.find((a) => a?.['name'] === input.action);
  if (prior === undefined) return { ok: false, errors: [`no action named '${input.action}' on this screen`] };
  const oldRules = Array.isArray(prior['rules']) ? (prior['rules'] as unknown[]) : [];
  if (!Number.isInteger(input.rule) || input.rule < 0 || input.rule >= oldRules.length) {
    return { ok: false, errors: ['that wire is already gone — the map catches up in a beat'] };
  }
  const rules = oldRules.filter((_, i) => i !== input.rule);
  const next = rules.length === 0
    ? existing.filter((a) => a?.['name'] !== input.action)
    : existing.map((a) => (a?.['name'] === input.action ? { ...a, rules } : a));
  const res = await setSceneContracts(sql, {
    orgId: input.orgId, sceneSlug: input.sceneSlug, bindings: row?.bindings ?? [], actions: next,
  });
  if (res.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'human.wire_removed',
      payload: { sceneSlug: input.sceneSlug, action: input.action, rule: input.rule, by: input.by },
    });
  }
  return res;
}
