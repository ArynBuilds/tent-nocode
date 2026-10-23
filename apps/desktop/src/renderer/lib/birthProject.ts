import { desk } from './desk.js';
import { navigate } from './router.js';

/**
 * THE ONE BIRTH LANE (R0 birth flow, re-housing ruling 2 → THE LIVE MAP 2026-07-31)
 * as re-ruled by B5 ㉞ (spec, 2026-08-05): A NEW PROJECT BIRTHS TRULY EMPTY — no
 * auto-"Home" screen, no seeded nodes (the scene-insert seed DIED here; it was
 * the WHOLE seeding machinery — the chat-birth lane births projects alone and
 * emptySceneDocument seeds root-only). Pick → the project births EMPTY → the center
 * lands on the MAP (`/` — the Stage's honest ground with no screens), where the ㉝
 * teach-once line greets: "right-click to create". Every entry starts the SAME flow —
 * never a second implementation. PROJECT FOCUS (2026-08-01): returns the born
 * projectId so the caller auto-focuses it (§1.4 — "New project" always focuses its
 * result); null = the role-side gate refused (renders nowhere).
 */
export async function birthProject(orgId: string, kind: 'app' | 'website'): Promise<string | null> {
  const res = await desk.createProjectOfKind(orgId, kind);
  if (!res.ok || res.data === undefined) return null; // a refusal renders nowhere — the gate is role-side
  navigate('/');
  return res.data.projectId;
}
