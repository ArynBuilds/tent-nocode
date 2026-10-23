import { BrowserWindow, Notification } from 'electron';
import type postgres from 'postgres';
import type { LiveEvent } from '../../shared/ipc.js';
import { escalationNotification, eventNotification, type NeedsYouNotification } from './needsYouRules.js';

// Shows OS toasts for needs-you events; a focused window never notifies, and a notifier bug never takes the live watcher down.

const ESCALATION_RECHECK_MS = 3000;

export function createNeedsYouNotifier(sql: postgres.Sql): (event: LiveEvent) => void {
  const notified = new Set<string>();

  function anyWindowFocused(): boolean {
    return BrowserWindow.getAllWindows().some((w) => w.isFocused());
  }

  function show(n: NeedsYouNotification): void {
    if (!Notification.isSupported() || anyWindowFocused()) return;
    const toast = new Notification({ title: n.title, body: n.body });
    toast.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    toast.show();
  }

  async function handle(event: LiveEvent): Promise<void> {
    // The notifier reads pointers alone; the computed pushes are the screens' business.
    if ('kind' in event) return;
    if (event.op !== 'INSERT') return;
    const key = `${event.table}:${event.id}`;
    if (notified.has(key)) return;

    if (event.table === 'events') {
      const [row] = await sql<{ type: string; payload: Record<string, unknown> }[]>`
        select type, payload from events where id = ${event.id}::bigint`;
      const n = row ? eventNotification(row.type) : null;
      if (n) {
        notified.add(key);
        show({ title: n.title, body: n.body });
      }
      return;
    }
    if (event.table === 'messages') {
      await new Promise((r) => setTimeout(r, ESCALATION_RECHECK_MS));
      const [row] = await sql<{ type: string; answered_at: Date | null; payload: Record<string, unknown> }[]>`
        select type, answered_at, payload from messages where id = ${event.id}`;
      const n = row
        ? escalationNotification({
            type: row.type,
            answeredAt: row.answered_at ? row.answered_at.toISOString() : null,
            payload: row.payload,
          })
        : null;
      if (n) {
        notified.add(key);
        show(n);
      }
    }
  }

  return (event) => {
    handle(event).catch((err) => {
      console.error('[needs-you] notification check failed:', err instanceof Error ? err.message : String(err));
    });
  };
}
