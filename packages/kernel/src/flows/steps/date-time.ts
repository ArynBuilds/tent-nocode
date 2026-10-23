import { isPill } from '@tent-nocode/core';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

// Shifts or reformats one field's date; unparseable values pass through, never reads the clock.

const MS_PER_UNIT: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export const dateTimeStep: FlowStepDef = {
  kind: 'date-time',
  displayName: 'Date & time',
  blurb: 'shifts or reformats a date field',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, pill: true, help: 'the date field (ISO)' },
    operation: {
      type: 'enum',
      required: true,
      choices: ['add', 'subtract', 'to-date', 'to-month', 'to-time'],
      help: 'what to do to the date',
    },
    amount: { type: 'number', help: 'how much (add/subtract)', showWhen: { param: 'operation', is: ['add', 'subtract'] } },
    unit: { type: 'enum', choices: ['minutes', 'hours', 'days'], help: 'what the amount counts', showWhen: { param: 'operation', is: ['add', 'subtract'] } },
    into: { type: 'string', help: 'where the answer lands (defaults to the field itself)' },
  },
  guidance: 'Reads one date field (ISO text) per row and rewrites it: to-date keeps YYYY-MM-DD, to-month keeps YYYY-MM, to-time keeps HH:MM, add/subtract shift by amount+unit. Unparseable values pass through unchanged - never an error. Set into to keep the original and land the answer in a new field; to-month before Summarize group-by is the monthly-report idiom.',
  examples: [
    { title: 'a month column for grouping', params: { field: 'created', operation: 'to-month', into: 'month' }, note: '2026-08-25T12:00:00Z -> { month: "2026-08" }' },
  ],
  exec: {
    pure: ({ params, inputs, resolve }): PureRunOutput => {
      const fieldRaw = params['field'];
      const operation = params['operation'];
      const amount = typeof params['amount'] === 'number' ? params['amount'] : 0;
      const unit = typeof params['unit'] === 'string' ? params['unit'] : 'minutes';
      const into = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : undefined;

      const out = (inputs['in'] ?? []).map((item) => {
        // field is a name; resolve only when the stored value is a pill object
        const fieldName = isPill(fieldRaw) ? resolve(fieldRaw, item) : fieldRaw;
        if (typeof fieldName !== 'string' || fieldName === '') return item;

        const raw = item.json[fieldName];
        const ms = typeof raw === 'string' || typeof raw === 'number' ? Date.parse(String(raw)) : NaN;
        if (Number.isNaN(ms)) return item;

        const step = MS_PER_UNIT[unit] ?? 60_000;
        let value: string;
        switch (operation) {
          case 'add':
            value = new Date(ms + amount * step).toISOString();
            break;
          case 'subtract':
            value = new Date(ms - amount * step).toISOString();
            break;
          case 'to-date':
            value = new Date(ms).toISOString().slice(0, 10);
            break;
          case 'to-month':
            value = new Date(ms).toISOString().slice(0, 7);
            break;
          case 'to-time':
            value = new Date(ms).toISOString().slice(11, 16);
            break;
          default:
            return item;
        }
        const key = into ?? fieldName;
        return { json: { ...item.json, [key]: value } };
      });
      return { outputs: { out } };
    },
  },
};
