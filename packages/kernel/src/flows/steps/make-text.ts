import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Writes a text from a template into a field on every row; no template passes items through. */
export const makeTextStep: FlowStepDef = {
  kind: 'make-text',
  displayName: 'Make text',
  blurb: 'writes a text from a template on every row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    template: { type: 'string', required: true, pill: true, help: 'the text; a pill or a template fills from the row' },
    into: { type: 'string', help: "the field the text lands in ('text' by default)" },
  },
  guidance: 'Writes one text per row from a template into a field (default: text). The template takes a pill or plain words; per-row values come from pills resolved against each row. The composer for messages, subjects, and summaries that a connection step or Answer the caller sends next.',
  examples: [
    { title: 'a per-row message', params: { template: { from: 'step', step: 'get-rows', path: 'customer' }, into: 'greeting' } },
  ],
  exec: {
    pure: ({ params, inputs, resolve }): PureRunOutput => {
      const template = params['template'];
      const field = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : 'text';
      if (template === undefined || template === null || template === '') {
        return { outputs: { out: inputs['in'] ?? [] } };
      }
      const out = (inputs['in'] ?? []).map((item) => {
        const value = resolve(template, item);
        return { json: { ...item.json, [field]: String(value ?? '') } };
      });
      return { outputs: { out } };
    },
  },
};
