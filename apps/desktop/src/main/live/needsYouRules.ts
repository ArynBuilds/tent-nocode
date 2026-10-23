// Pure rules mapping record events to the two notifications ("Waiting on you" / "Finished"); Electron-free for tests.

export interface NeedsYouNotification {
  title: string;
  body: string;
}

const WAITING: NeedsYouNotification = { title: 'Waiting on you', body: 'The work stopped and needs you.' };
const FINISHED: NeedsYouNotification = { title: 'Finished', body: 'The work is done — the result is in the thread.' };

/** Maps an event type to a notification. */
export function eventNotification(type: string): NeedsYouNotification | null {
  switch (type) {
    case 'intent.parked':
    case 'policy.denied':
      return WAITING;
    case 'intent.completed':
      return FINISHED;
    default:
      return null;
  }
}

/** Returns the waiting notification for a still-unanswered escalation. */
export function escalationNotification(row: {
  type: string;
  answeredAt: string | null;
  payload: Record<string, unknown>;
}): NeedsYouNotification | null {
  if (row.type !== 'escalation' || row.answeredAt !== null) return null;
  return { title: 'Waiting on you', body: 'A consent needs your answer.' };
}
