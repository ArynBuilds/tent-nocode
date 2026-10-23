import type postgres from 'postgres';
import type { ThreadMode } from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { spawnRun } from '../scheduler.js';
import { sanitizeLabel } from '../sanitize.js';
import { DESK_SLUG, ensureDeskAgent } from './desk.js';
import { getSubtree } from '../scenes/read.js';
import { getSceneDocument } from '../scenes/store.js';
import { resetWakeTank } from './intents.js';
import { voiceTurnRules } from '../consent.js';

export interface CreateThreadInput {
  orgId: string;
  title: string;
  createdBy: string;
  /** Omitted → thread inherits orgConfig.chat.defaultMode. */
  mode?: ThreadMode;
  /** Required — a project-less thread is not representable. */
  projectId: string;
}

/** Starts a conversation: inserts the thread row and emits the created event. */
export async function createThread(sql: postgres.Sql, input: CreateThreadInput): Promise<{ threadId: string }> {
  const rows = await sql<{ id: string }[]>`
    insert into threads (org_id, title, created_by, mode, project_id)
    values (${input.orgId}, ${input.title}, ${input.createdBy}, ${input.mode ?? null}, ${input.projectId})
    returning id`;
  const row = rows[0];
  if (!row) throw new Error('thread insert returned no row');
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.chat', type: 'thread.created',
    payload: { threadId: row.id, title: input.title },
  });
  return { threadId: row.id };
}

export interface SpawnDeskTurnInput {
  orgId: string;
  threadId: string;
  userMessage: string;
  /** Extra keys merged into the run input (e.g. `arrivedMidJob`, `loopWake`, `loopParked`). */
  extraInput?: Record<string, unknown>;
}

/** One system-initiated desk turn on the thread; no user message row is written. */
export async function spawnDeskTurn(
  sql: postgres.Sql, input: SpawnDeskTurnInput,
): Promise<{ runId: string }> {
  const { runId } = await spawnRun(sql, {
    orgId: input.orgId, agentSlug: DESK_SLUG, kind: 'chat', threadId: input.threadId,
    prompt: input.userMessage.slice(0, 200),
    input: { threadId: input.threadId, userMessage: input.userMessage, ...(input.extraInput ?? {}) },
    permissionRules: await voiceTurnRules(sql, input.orgId),
  });
  return { runId };
}

/** The shell's send-time facts: theme, open screen, and current selection; null selection rides so the desk sees absence. */
export interface AmbientEnvelopeInput {
  /** The app chrome's theme at send time. */
  theme?: 'dark' | 'light';
  /** The open screen (the lens's editing truth); absent = no page editor open. */
  screen?: { sceneSlug: string };
  /** null = nothing selected right now - passed explicitly, never guessed. */
  selection?:
    | { surface: 'lens'; sceneSlug: string; nodeId: string }
    | { surface: 'map'; kind: string; nodeId: string; label: string }
    | null;
}

export interface CreateChatTurnInput {
  orgId: string; threadId: string; text: string; by: string;
  /** Point-and-ask: the system injects the node's compact subtree into the turn input. */
  selection?: { sceneSlug: string; nodeId: string };
  /** The ambient envelope lane (see AmbientEnvelopeInput). */
  envelope?: AmbientEnvelopeInput;
}

/** One user chat message becomes one desk run; a failed turn reports, it never silently retries. */
export async function createChatTurn(
  sql: postgres.Sql,
  input: CreateChatTurnInput,
): Promise<{ runId: string; messageId: string }> {
  await ensureDeskAgent(sql, input.orgId);

  // A human message resets the wake budget and reopens a parked mission before the desk turn runs.
  await resetWakeTank(sql, { orgId: input.orgId, threadId: input.threadId });

  // The pointed node's subtree is fetched kernel-side before any model sees the turn; a vanished node degrades to an honest note.
  let sceneSelection: Record<string, unknown> | undefined;
  if (input.selection) {
    try {
      const { subtree, revision } = await getSubtree(sql, {
        orgId: input.orgId, sceneSlug: input.selection.sceneSlug,
        nodeId: input.selection.nodeId, depth: 2, maxNodes: 20,
      });
      sceneSelection = {
        sceneSlug: input.selection.sceneSlug, nodeId: input.selection.nodeId, revision,
        subtree: subtree ?? null,
        note: subtree
          ? 'the user POINTED at this node in the rendered scene — "this" in their message means it; revise via revise_view with focusNodeId set to this node id'
          : 'the user pointed at a node that a later revision removed — say so honestly',
      };
    } catch {
      sceneSelection = undefined; // an unreadable selection never costs the turn
    }
  }

  // The ambient envelope, resolved kernel-side; a vanished screen or node degrades honestly, never a dead turn.
  let ambient: Record<string, unknown> | undefined;
  if (input.envelope !== undefined) {
    let activeScreen: Record<string, unknown> | null = null;
    if (input.envelope.screen !== undefined) {
      try {
        const [scene] = await sql<{ id: string; slug: string; title: string }[]>`
          select id, slug, title from scenes
          where org_id = ${input.orgId} and slug = ${input.envelope.screen.sceneSlug}
            and status != 'deleted'`;
        if (scene) {
          const doc = await getSceneDocument(sql, { orgId: input.orgId, sceneId: scene.id });
          activeScreen = {
            slug: scene.slug, title: sanitizeLabel(scene.title),
            'descendant-count': Math.max(0, Object.keys(doc.nodes).length - 1),
            truncated: true, // metadata only - the tree is a read
          };
        }
      } catch { activeScreen = null; }
    }
    let selection: Record<string, unknown> | null = null;
    const sel = input.envelope.selection;
    if (sel !== undefined && sel !== null) {
      if (sel.surface === 'lens') {
        let classes: string[] = [];
        let gone = false;
        try {
          const { subtree } = await getSubtree(sql, {
            orgId: input.orgId, sceneSlug: sel.sceneSlug, nodeId: sel.nodeId, depth: 0, maxNodes: 1,
          });
          if (subtree === null) gone = true;
          else classes = Object.keys(subtree.components).filter((k) => k.includes('::'));
        } catch { /* classes stay empty - the ids still ground "this" */ }
        selection = {
          surface: 'lens', scene: sel.sceneSlug, node: sel.nodeId, classes,
          ...(gone ? { note: 'the selected node no longer exists in the scene - say so honestly' } : {}),
        };
      } else {
        selection = {
          surface: 'map', kind: sel.kind, node: sel.nodeId,
          label: sanitizeLabel(sel.label).slice(0, 80),
        };
      }
    }
    ambient = {
      ...(input.envelope.theme !== undefined ? { theme: input.envelope.theme } : {}),
      'active-screen': activeScreen,
      selection,
    };
  }

  const [msg] = await sql<{ id: string }[]>`
    insert into messages (org_id, type, payload)
    values (${input.orgId}, 'chat', ${sql.json({
      threadId: input.threadId, text: input.text, by: input.by, role: 'user',
      ...(input.selection ? { selection: input.selection } : {}),
    } as unknown as postgres.JSONValue)})
    returning id`;
  if (!msg) throw new Error('message insert returned no row');

  const { runId } = await spawnRun(sql, {
    orgId: input.orgId, agentSlug: DESK_SLUG, kind: 'chat', threadId: input.threadId,
    prompt: input.text.slice(0, 200),
    input: {
      threadId: input.threadId, messageId: msg.id, userMessage: input.text,
      ...(sceneSelection ? { sceneSelection } : {}),
      ...(ambient !== undefined ? { envelope: ambient } : {}),
    },
    permissionRules: await voiceTurnRules(sql, input.orgId),
  });
  return { runId, messageId: msg.id };
}
