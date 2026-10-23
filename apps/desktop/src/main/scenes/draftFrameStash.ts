// In-memory per-org stash of the latest captured scene frame; session-transient, never persisted.

export interface DraftFrame {
  sceneId: string;
  pngBase64: string;
  at: string;
}

const latest = new Map<string, DraftFrame>();

/** Called by the capture lanes after a successful capture. */
export function stashDraftFrame(orgId: string, sceneId: string, png: Buffer): void {
  latest.set(orgId, { sceneId, pngBase64: png.toString('base64'), at: new Date().toISOString() });
}

/** Returns the newest frame this session, or null; freshness gating is the caller's job. */
export function latestDraftFrame(orgId: string): DraftFrame | null {
  return latest.get(orgId) ?? null;
}
