import { conditionSchema, type FlowCondition, type FlowItem } from '@nodeloom/core';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

interface Rule {
  port: string;
  condition: FlowCondition;
}

/** Parses + validates params['rules'] into typed rules, or null on any malformed shape. */
function parseRules(raw: unknown): Rule[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rules: Rule[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const port = (entry as Record<string, unknown>)['port'];
    if (typeof port !== 'string' || port === '') return null;
    const parsed = conditionSchema.safeParse((entry as Record<string, unknown>)['condition']);
    if (!parsed.success) return null;
    rules.push({ port, condition: parsed.data });
  }
  return rules;
}

/** Routes each row down the first matching rule's port; ports come from the rules param itself. */
export const splitByRulesStep: FlowStepDef = {
  kind: 'split-by-rules',
  displayName: 'Split by rules',
  blurb: 'routes each row down the first rule that matches',
  inputs: SINGLE_IN,
  outputs: 'dynamic',
  params: {
    rules: {
      type: 'json',
      required: true,
      pill: false,
      help: 'a list of { port, condition } — each condition is the shared grammar',
    },
    fallback: {
      type: 'string',
      help: 'the port for rows no rule matches (empty = they drop quietly)',
    },
  },
  guidance: 'Routes each row down the FIRST rule whose condition matches - the ports on the tile come from the rules themselves ({ port, condition } each). Rows matching nothing go to fallback when set, else drop quietly. The many-way If.',
  examples: [
    { title: 'route by job type', params: { rules: [{ port: 'repairs', condition: { combine: 'and', rules: [{ left: { from: 'step', step: 'get-rows', path: 'job-type' }, op: 'equals', right: 'repair' }] } }], fallback: 'other' } },
  ],
  exec: {
    pure: ({ params, inputs, evalCondition }): PureRunOutput => {
      const rules = parseRules(params['rules']);
      if (!rules) return { outputs: {}, error: 'the Split by rules step needs a valid list of rules' };
      const fallback = params['fallback'];
      const fallbackPort = typeof fallback === 'string' && fallback !== '' ? fallback : null;

      const outputs: Record<string, FlowItem[]> = {};
      const send = (port: string, item: FlowItem) => {
        (outputs[port] ??= []).push(item);
      };

      for (const item of inputs['in'] ?? []) {
        const hit = rules.find((rule) => evalCondition(rule.condition, item));
        if (hit) send(hit.port, item);
        else if (fallbackPort) send(fallbackPort, item);
      }
      return { outputs };
    },
  },
};
