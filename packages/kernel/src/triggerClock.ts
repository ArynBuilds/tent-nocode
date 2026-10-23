// Pure clock math for the schedule/cron/interval trigger kinds; the first evaluation observes, never fires.

/** 5-field cron matcher (minute hour dom month dow); malformed fields match nothing. */
export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return fields.every((field, i) => cronFieldMatches(field, values[i]!));
}

function cronFieldMatches(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    if (part === '*') return true;
    const step = /^\*\/(\d+)$/.exec(part);
    if (step !== null) { const n = Number(step[1]); return n > 0 && value % n === 0; }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range !== null) return value >= Number(range[1]) && value <= Number(range[2]);
    const n = /^(\d+)$/.exec(part);
    return n !== null && value === Number(n[1]);
  });
}

/** The minute key a cron fire dedupes on (one fire per matching minute). */
export const minuteKey = (d: Date): string => d.toISOString().slice(0, 16);

export interface ClockVerdict { fire: boolean; nextState: Record<string, unknown> }

/** INTERVAL: every N minutes from the armed moment. */
export function intervalVerdict(spec: { minutes: number }, es: Record<string, unknown>, now: Date): ClockVerdict {
  const last = typeof es['lastFiredAt'] === 'string' ? Date.parse(es['lastFiredAt']) : null;
  if (last === null) return { fire: false, nextState: { ...es, lastFiredAt: now.toISOString() } }; // arm
  const due = now.getTime() - last >= spec.minutes * 60_000;
  return due
    ? { fire: true, nextState: { ...es, lastFiredAt: now.toISOString() } }
    : { fire: false, nextState: es };
}

/** SCHEDULE: daily at HH:MM, UTC. */
export function scheduleVerdict(spec: { time: string }, es: Record<string, unknown>, now: Date): ClockVerdict {
  const today = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16);
  const passed = hhmm >= spec.time;
  if (es['lastFiredDate'] === undefined) {
    // arm-on-first-sight: a time already past today does not fire today.
    return { fire: false, nextState: { ...es, lastFiredDate: passed ? today : '' } };
  }
  const due = passed && es['lastFiredDate'] !== today;
  return due
    ? { fire: true, nextState: { ...es, lastFiredDate: today } }
    : { fire: false, nextState: es };
}

/** CRON: one fire per matching minute (the sweep tick is the floor). */
export function cronVerdict(spec: { expr: string }, es: Record<string, unknown>, now: Date): ClockVerdict {
  const key = minuteKey(now);
  if (es['lastFiredMinute'] === undefined) {
    return { fire: false, nextState: { ...es, lastFiredMinute: '' } }; // arm
  }
  const due = cronMatches(spec.expr, now) && es['lastFiredMinute'] !== key;
  return due
    ? { fire: true, nextState: { ...es, lastFiredMinute: key } }
    : { fire: false, nextState: es };
}
