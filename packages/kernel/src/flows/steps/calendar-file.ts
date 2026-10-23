import { createHash } from 'node:crypto';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

// Writes an ICS calendar invite into a field per item; deterministic, never reads the clock.

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const HOUR_MS = 3_600_000;

export const calendarFileStep: FlowStepDef = {
  kind: 'calendar-file',
  displayName: 'Calendar file',
  blurb: 'writes a calendar invite from every row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    title: { type: 'string', required: true, pill: true, help: 'the event title' },
    start: { type: 'string', required: true, pill: true, help: 'when it starts (a date the row carries)' },
    end: { type: 'string', pill: true, help: 'when it ends (one hour after the start by default)' },
    location: { type: 'string', pill: true, help: 'where it happens' },
    details: { type: 'string', pill: true, help: 'the description' },
    into: { type: 'string', help: "the field the invite lands in ('calendar' by default)" },
  },
  guidance: 'Writes a complete ICS calendar invite as TEXT into a field on every row - it does not send anything. start must be a parseable date (ISO text works); a row with no title or an unreadable start passes through unchanged. Send the invite with a connection step or save it to a table afterwards.',
  examples: [
    { title: 'an invite per booking row', params: { title: { from: 'step', step: 'get-rows', path: 'customer' }, start: { from: 'step', step: 'get-rows', path: 'starts' }, into: 'invite' } },
  ],
  exec: {
    pure: ({ params, inputs, resolve }): PureRunOutput => {
      const into = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : 'calendar';
      const out = (inputs['in'] ?? []).map((item) => {
        const title = String(resolve(params['title'], item) ?? '');
        const startRaw = resolve(params['start'], item);
        const startMs = startRaw === undefined || startRaw === null ? NaN : Date.parse(String(startRaw));
        if (title === '' || Number.isNaN(startMs)) return item;
        const endRaw = resolve(params['end'], item);
        const endParsed = endRaw === undefined || endRaw === null || endRaw === '' ? NaN : Date.parse(String(endRaw));
        const endMs = Number.isNaN(endParsed) ? startMs + HOUR_MS : endParsed;
        const location = String(resolve(params['location'], item) ?? '');
        const details = String(resolve(params['details'], item) ?? '');
        const uid = createHash('sha1').update(`${title}|${startMs}|${endMs}`).digest('hex');

        const lines = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Tent NoCode//flows//EN',
          'BEGIN:VEVENT',
          `UID:${uid}@tent-nocode`,
          `DTSTAMP:${icsDate(startMs)}`,
          `DTSTART:${icsDate(startMs)}`,
          `DTEND:${icsDate(endMs)}`,
          `SUMMARY:${icsEscape(title)}`,
          ...(location !== '' ? [`LOCATION:${icsEscape(location)}`] : []),
          ...(details !== '' ? [`DESCRIPTION:${icsEscape(details)}`] : []),
          'END:VEVENT',
          'END:VCALENDAR',
        ];
        return { json: { ...item.json, [into]: lines.join('\r\n') } };
      });
      return { outputs: { out } };
    },
  },
};
