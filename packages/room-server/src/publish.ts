import { z } from 'zod';
import type postgres from 'postgres';
import { releaseEngineSchema } from '@nodeloom/core';
import {
  appendRoomRelease, currentRelease, deleteScene, emitEvent, ensureRoom, ensureRoomApp,
  findReleaseByPackageHash, importPackage, readTentkitBuild, setAppVisibility, validateAppSlug,
  validateLsgPackage,
} from '@nodeloom/kernel';

// Publish door: validates the tproject@2 package, lands it through the one merge (supersede over the prior
// release), appends the release with the tentkit build's integrity in its envelope; idempotent by package hash.

export const publishEnvelopeSchema = z
  .object({
    version: z.string().min(1).max(100),
    publishedAt: z.string().min(1),
    packageHash: z.string().length(64),
    title: z.string().min(1).max(200).optional(),
    kind: z.enum(['app', 'website']).optional(),
    designSize: z.object({ w: z.number(), h: z.number() }).passthrough().optional(),
    // The chosen front page; honored when it landed, else the first landed screen.
    entrySceneSlug: z.string().min(1).max(200).optional(),
    // The assistant declaration the web pill renders from.
    assistant: z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }).strict().optional(),
    // The engine build the release renders on (the door stamps the host's own when the caller sends none).
    engine: releaseEngineSchema.optional(),
  })
  .passthrough();

// 20MB caps the manifest half; the data lane rides under its own ceiling.
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const MAX_DATA_LANE_BYTES = 200 * 1024 * 1024;
const FAILURE_SENTENCE = "Publishing didn't finish - your app is unchanged. Try again.";

export interface PublisherIdentity { userId: string; email?: string; displayName?: string }
export type TokenVerifier = (token: string) => Promise<PublisherIdentity | null>;

export interface PublishInput {
  token: string;
  appSlug: string;
  title?: string;
  envelope: unknown;
  file: unknown;
}

export type PublishResult =
  | { ok: true; url: string; releaseHash: string; alreadyPublished?: boolean }
  | { ok: false; refusal: string; details?: string[] };

export interface UnpublishInput { token: string; appSlug: string }
export type UnpublishResult = { ok: true } | { ok: false; refusal: string };

export function createPublishDoor(deps: {
  /** A fresh max-1 connection per call; the door ends it. */
  connect: () => postgres.Sql;
  verifyToken: TokenVerifier;
  /** The live address of a published app, from its slug (scheme, host and port are the host's). */
  appUrl: (appSlug: string) => string;
  /** The host's engines dir; the release envelope records the build it will render on. */
  enginesDir?: string;
}): { publish(input: PublishInput): Promise<PublishResult>; unpublish(input: UnpublishInput): Promise<UnpublishResult> } {
  const landedList = (key: string, rec: Record<string, unknown> | undefined): string[] =>
    rec !== undefined && Array.isArray(rec[key])
      ? (rec[key] as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
  return {
    /** Unpublish: served screens tombstone and visibility flips off; releases stay append-only. */
    async unpublish(input: UnpublishInput): Promise<UnpublishResult> {
      const who = input.token ? await deps.verifyToken(input.token) : null;
      if (!who) return { ok: false, refusal: 'sign in to unpublish - this door is nodeloom-account authenticated' };
      const slugCheck = validateAppSlug(input.appSlug);
      if (!slugCheck.ok) return { ok: false, refusal: slugCheck.error };
      const lane = deps.connect();
      try {
        const name = who.displayName ?? who.email ?? 'account';
        const [minted] = await lane<{ org: string }[]>`
          select mint_account_org(${who.userId}::uuid, ${name}, ${who.email ?? ''}) as org`;
        const orgId = minted?.org;
        if (!orgId) return { ok: false, refusal: 'account org could not be resolved' };
        await lane`select set_config('app.org_id', ${orgId}, false), set_config('app.project_id', '', false)`;
        const [app] = await lane<{ id: string }[]>`
          select id from room_apps where org_id = ${orgId} and app_slug = ${input.appSlug}`;
        if (!app) return { ok: false, refusal: `no published app at '${input.appSlug}' on your account` };
        // Tombstone the served screens; landed sets from the release, events fallback.
        const release = await currentRelease(lane, app.id);
        const landedScenes = release !== null ? landedList('scenes', release.landed) : [];
        for (const slug of landedScenes) {
          await deleteScene(lane, { orgId, sceneSlug: slug, reason: 'its app was unpublished' }).catch(() => undefined);
        }
        await setAppVisibility(lane, { orgId, appSlug: input.appSlug, visibility: 'off' });
        await emitEvent(lane, {
          orgId, actor: 'kernel.rooms', type: 'room.app_unpublished',
          payload: { appSlug: input.appSlug, scenes: landedScenes.length, by: who.userId },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, refusal: err instanceof Error ? err.message : String(err) };
      } finally {
        await lane.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    async publish(input: PublishInput): Promise<PublishResult> {
      const who = input.token ? await deps.verifyToken(input.token) : null;
      if (!who) return { ok: false, refusal: 'sign in to publish - this door is nodeloom-account authenticated' };

      const slugCheck = validateAppSlug(input.appSlug);
      if (!slugCheck.ok) return { ok: false, refusal: slugCheck.error };

      const { data: laneHalf, ...manifestHalf } = ((input.file ?? {}) as Record<string, unknown>);
      if (JSON.stringify(input.file === null || input.file === undefined ? null : manifestHalf).length > MAX_MANIFEST_BYTES) {
        return { ok: false, refusal: 'this app is larger than the 20MB publish cap (its data lane rides separately and does not count)' };
      }
      if (laneHalf !== undefined) {
        const laneBytes = JSON.stringify(laneHalf).length;
        if (laneBytes > MAX_DATA_LANE_BYTES) {
          return { ok: false, refusal: `the package's data lane is ${(laneBytes / (1024 * 1024)).toFixed(1)}MB - beyond the ${MAX_DATA_LANE_BYTES / (1024 * 1024)}MB ceiling; untick a table or trim it` };
        }
      }

      const env = publishEnvelopeSchema.safeParse(input.envelope);
      if (!env.success) {
        return { ok: false, refusal: 'the release envelope is malformed', details: env.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) };
      }

      const validated = validateLsgPackage(input.file);
      if (!validated.ok) return { ok: false, refusal: FAILURE_SENTENCE, details: validated.errors };
      const pkg = validated.pkg;

      if (env.data.packageHash !== pkg.packageHash) {
        return { ok: false, refusal: 'the envelope does not match the package (tampered or stale upload)' };
      }

      // Native-runtime ops never execute on the cloud.
      for (const entry of pkg.entries) {
        if (entry.kind !== 'operation') continue;
        const runtime = (entry.registration as { runtime?: unknown }).runtime;
        if (runtime === 'native') {
          return { ok: false, refusal: `operation '${entry.name}' runs the native runtime - native operations never execute on the cloud; export a wasm build` };
        }
      }

      // The engine build the page will render on, pinned by its integrity (pacote's shape).
      let engine = env.data.engine;
      if (engine === undefined && deps.enginesDir !== undefined) {
        const build = await readTentkitBuild(deps.enginesDir);
        if (build !== null) engine = { name: 'tentkit', file: build.file, integrity: build.integrity, version: build.version };
      }

      const lane = deps.connect();
      const url = deps.appUrl(input.appSlug);
      try {
        // Resolve-or-mint the account org; runs before tenant context because it establishes it.
        const name = who.displayName ?? who.email ?? 'account';
        const [minted] = await lane<{ org: string }[]>`
          select mint_account_org(${who.userId}::uuid, ${name}, ${who.email ?? ''}) as org`;
        const orgId = minted?.org;
        if (!orgId) return { ok: false, refusal: FAILURE_SENTENCE, details: ['account org could not be resolved'] };

        // Session-scoped tenant pin on this connection only.
        await lane`select set_config('app.org_id', ${orgId}, false), set_config('app.project_id', '', false)`;

        const room = await ensureRoom(lane, { orgId, slug: input.appSlug });
        const app = await ensureRoomApp(lane, {
          roomId: room.id, orgId, appSlug: input.appSlug,
          title: input.title ?? input.appSlug,
        });
        // A republish over an unpublished app must land and flip the app live again.
        const wasUnpublished = app.visibility === 'off';

        // Idempotent by package hash: same bytes = no-op.
        const prior = await findReleaseByPackageHash(lane, { roomAppId: app.id, packageHash: pkg.packageHash });
        if (prior && !wasUnpublished) {
          return { ok: true, url, releaseHash: prior.releaseHash, alreadyPublished: true };
        }

        // Republish replaces: prior landed sets feed the supersede landing; room data stays untouched.
        const priorRelease = await currentRelease(lane, app.id);
        let priorLanded: Record<string, unknown> | undefined = priorRelease?.landed;
        if (priorRelease && landedList('scenes', priorLanded).length === 0) {
          // An idempotent republish appended landed {}; recover the landing from the record.
          const [ev] = await lane<{ payload: { landed?: Record<string, unknown> } }[]>`
            select payload from events
            where org_id = ${orgId} and type = 'package.imported'
              and payload->>'packageHash' = ${priorRelease.packageHash}
            order by id desc limit 1`;
          priorLanded = ev?.payload.landed ?? priorLanded;
        }
        const priorScenes = landedList('scenes', priorLanded);

        // A republish lands in the app's own standing project, resolved from prior landed screens; a first publish finds or births one.
        let standingProjectId: string | null = null;
        if (priorScenes.length > 0) {
          const [home] = await lane<{ project_id: string }[]>`
            select project_id from scenes
            where org_id = ${orgId} and slug = any(${lane.array(priorScenes)}::text[])
              and project_id is not null
            limit 1`;
          standingProjectId = home?.project_id ?? null;
        }
        const landed = await importPackage(lane, {
          orgId, file: input.file, createdBy: who.userId, onCollision: 'skip-existing',
          sceneStrategy: 'supersede', priorScenes,
          priorComponents: landedList('components', priorLanded),
          priorOperations: landedList('operations', priorLanded),
          ...(standingProjectId !== null
            ? { projectId: standingProjectId }
            : { findOrBirthProject: true, sourcePath: input.title ?? input.appSlug }),
        });
        if (!landed.ok) return { ok: false, refusal: FAILURE_SENTENCE, details: landed.errors };

        // The chosen entry screen when it landed; the first landed screen as fallback.
        let landedScenes = landed.landed?.scenes ?? [];
        if (landedScenes.length === 0 && landed.alreadyImported) {
          // Recover the landing from the import event.
          const [ev] = await lane<{ payload: { landed?: { scenes?: string[] } } }[]>`
            select payload from events
            where org_id = ${orgId} and type = 'package.imported'
              and payload->>'packageHash' = ${pkg.packageHash}
            order by id desc limit 1`;
          landedScenes = ev?.payload.landed?.scenes ?? [];
        }
        const chosenEntry = env.data.entrySceneSlug;
        const entrySceneSlug = (chosenEntry !== undefined && landedScenes.includes(chosenEntry))
          ? chosenEntry
          : landedScenes[0] ?? null;

        // Hash idempotence skipped the landing but unpublish tombstoned these screens; revive them.
        const revived: string[] = [];
        if (wasUnpublished && landed.alreadyImported && landedScenes.length > 0) {
          const rows = await lane<{ id: string }[]>`
            update scenes set status = 'active', deleted_at = null
            where org_id = ${orgId} and slug = any(${lane.array(landedScenes)}::text[])
              and status = 'deleted'
            returning id`;
          revived.push(...rows.map((r) => r.id));
        }

        // A failed release append undoes the import's landings whole.
        let release;
        try {
          release = await appendRoomRelease(lane, {
            roomAppId: app.id, orgId, packageHash: pkg.packageHash,
            envelope: { ...(env.data as Record<string, unknown>), ...(engine !== undefined ? { engine } : {}) },
            entrySceneSlug,
            landed: (landed.landed ?? {}) as unknown as Record<string, unknown>,
          });
        } catch (err) {
          await landed.compensate?.();
          for (const id of revived) {
            await lane`update scenes set status = 'deleted', deleted_at = now() where id = ${id}`.catch(() => undefined);
          }
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, refusal: FAILURE_SENTENCE, details: [message] };
        }
        // A successful republish turns an unpublished app live again.
        if (wasUnpublished) {
          await setAppVisibility(lane, { orgId, appSlug: input.appSlug, visibility: 'public' });
        }
        return { ok: true, url, releaseHash: release.releaseHash };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, refusal: FAILURE_SENTENCE, details: [message] };
      } finally {
        await lane.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}
