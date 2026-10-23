import { createHash } from 'node:crypto';
import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

// Hashes one field per item into hex (sha256 default); a missing field passes through.
export const hashStep: FlowStepDef = {
  kind: 'hash',
  displayName: 'Scramble',
  blurb: 'hashes a field (one way, for ids and checks)',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the field to hash' },
    algorithm: { type: 'enum', choices: ['sha256', 'sha1', 'md5'], help: 'sha256 is the default' },
    into: { type: 'string', help: 'where the digest lands (defaults to the field)' },
  },
  guidance: 'One-way hash of one field into hex - for stable ids and change checks, never encryption. A row missing the field passes through unchanged. Hash a natural key before Save rows into a keyed table to get clean upserts.',
  examples: [
    { title: 'a stable id from the url', params: { field: 'url', into: 'id' } },
  ],
  exec: {
    pure: ({ params, inputs }) => {
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      const algorithm = params['algorithm'] === 'sha1' || params['algorithm'] === 'md5' ? params['algorithm'] : 'sha256';
      const into = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : field;
      const items = inputs['in'] ?? [];
      if (field === '') return { outputs: { out: items } };
      const out = items.map((item) => {
        if (!Object.prototype.hasOwnProperty.call(item.json, field)) return item;
        const digest = createHash(algorithm).update(String(item.json[field])).digest('hex');
        return { json: { ...item.json, [into]: digest } };
      });
      return { outputs: { out } };
    },
  },
};
