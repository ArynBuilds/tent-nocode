import { decodeWorkspaceWire } from '@nodeloom/core';
import type { LiveEvent } from '@nodeloom/kernel';

// The one door to the local server's workspace: POST /workspace/call per channel,
// GET /workspace/live for the SSE pointer stream. Bearer token stays main-process only.

export const SIGN_IN_WORKSPACE = 'Unlock the app first - enter your password.';
export const OFFLINE_WORKSPACE = "the local server is not answering - restart the app";

export interface WorkspaceClientDeps {
  origin: string;
  /** The live access token — null when signed out. */
  token: () => string | null;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
}

export interface WorkspaceLiveHandle {
  stop: () => void;
}

export interface WorkspaceClient {
  /** One channel call: returns the channel's data or throws its one plain sentence. */
  call(channel: string, args: unknown[]): Promise<unknown>;
  /** The desk_live pointer stream over SSE — reconnects itself until stopped. */
  startLive(onEvent: (event: LiveEvent) => void, opts?: { retryDelayMs?: number }): WorkspaceLiveHandle;
}

/** Incremental SSE parser: feed text, get completed data payloads. Exported for tests. */
export function createSseParser(): { feed(text: string): string[] } {
  let buffer = '';
  return {
    feed(text: string): string[] {
      buffer += text;
      const out: string[] = [];
      let cut = buffer.indexOf('\n\n');
      while (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data !== '') out.push(data);
        cut = buffer.indexOf('\n\n');
      }
      return out;
    },
  };
}

/** A malformed live frame is dropped and logged, never forwarded; a pointer or a computed push (binding, effects) passes. */
function asLiveEvent(raw: string): LiveEvent {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed['kind'] === 'binding' || parsed['kind'] === 'effects') {
    if (typeof parsed['orgId'] !== 'string' || typeof parsed['scene'] !== 'string') throw new Error('workspace live frame is a push without its org or screen');
    return parsed as unknown as LiveEvent;
  }
  if (typeof parsed['table'] !== 'string' || typeof parsed['op'] !== 'string' || typeof parsed['id'] !== 'string') {
    throw new Error('workspace live frame is not a pointer event');
  }
  if (parsed['orgId'] !== null && typeof parsed['orgId'] !== 'string') {
    throw new Error('workspace live frame carries a malformed orgId');
  }
  return parsed as unknown as LiveEvent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The wired singleton: boot constructs the one client and sets it here.

let wired: WorkspaceClient | null = null;

let wiredOrigin: string | null = null;

export function setWorkspaceClient(client: WorkspaceClient, origin: string): void {
  wired = client;
  wiredOrigin = origin;
}

/** The local server's origin; publish and unpublish post beside the call door. */
export function workspaceOrigin(): string {
  if (wiredOrigin === null) throw new Error('the workspace door is not wired yet - a boot-order bug, never a user state');
  return wiredOrigin;
}

/** The one call door — returns the channel's data or throws one plain sentence. */
export async function workspaceCall(channel: string, args: unknown[] = []): Promise<unknown> {
  if (wired === null) throw new Error('the workspace door is not wired yet — a boot-order bug, never a user state');
  return wired.call(channel, args);
}

export function createWorkspaceClient(deps: WorkspaceClientDeps): WorkspaceClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? ((line: string) => console.error(line));

  return {
    async call(channel: string, args: unknown[]): Promise<unknown> {
      const token = deps.token();
      if (token === null) throw new Error(SIGN_IN_WORKSPACE);
      let out: { ok?: boolean; data?: unknown; error?: string };
      try {
        const res = await fetchFn(`${deps.origin}/workspace/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ channel, args }),
          signal: AbortSignal.timeout(30_000),
        });
        out = (await res.json()) as typeof out;
      } catch {
        throw new Error(OFFLINE_WORKSPACE);
      }
      if (out.ok !== true) {
        throw new Error(typeof out.error === 'string' ? out.error : 'the workspace refused this call');
      }
      // Tagged base64 envelopes become ArrayBuffers again.
      return decodeWorkspaceWire(out.data);
    },

    startLive(onEvent: (event: LiveEvent) => void, opts?: { retryDelayMs?: number }): WorkspaceLiveHandle {
      const baseDelay = opts?.retryDelayMs ?? 1_000;
      let stopped = false;
      let controller: AbortController | null = null;

      const run = async (): Promise<void> => {
        let delay = baseDelay;
        while (!stopped) {
          const token = deps.token();
          if (token === null) {
            // Signed out: nothing to stream — wait for a session, quietly.
            await sleep(delay);
            continue;
          }
          try {
            controller = new AbortController();
            const res = await fetchFn(`${deps.origin}/workspace/live`, {
              headers: { authorization: `Bearer ${token}` },
              signal: controller.signal,
            });
            if (!res.ok || res.body === null) throw new Error(`the live door answered ${res.status}`);
            delay = baseDelay; // connected — the backoff resets
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const parser = createSseParser();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
                try {
                  onEvent(asLiveEvent(payload));
                } catch (err) {
                  log(`[workspace live] dropped malformed frame: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          } catch {
            // Fall through to the retry; the stream itself reports nothing.
          }
          if (!stopped) {
            await sleep(delay);
            delay = Math.min(delay * 2, 30_000);
          }
        }
      };
      void run();

      return {
        stop: (): void => {
          stopped = true;
          controller?.abort();
        },
      };
    },
  };
}
