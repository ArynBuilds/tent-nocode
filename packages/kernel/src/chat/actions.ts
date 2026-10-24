import { z } from 'zod';
import type postgres from 'postgres';
import { resolveProject } from '../containment.js';
import type { ExecutionDriver } from '@nodeloom/core';
import { applyUserRevision, type ApplyResult } from '../scenes/apply.js';
import { compileSceneDialectAt, DIALECT_FIX_SENTENCE } from '../dialect.js';
import { setOrgConfig } from '../config.js';
import { setThreadMode, writeConsentGrant } from '../consent.js';
import { addConnection } from '../connections.js';
import { emitEvent } from '../events.js';
import { TAB_ACTIONS } from '../tabs/actions.js';
import { createProject, projectThemeSchema, renameProject, setProjectTheme, type ProjectTheme } from '../projects.js';
import { createOrgComponent, validateOrgDefinition, type ComponentMigrationMap } from '../scenes/library.js';
import { importComponent, validateComponentFile } from '../scenes/portability.js';
import { OPERATION_ACTIONS } from '../operations/gate.js';
import { PACKAGE_ACTIONS } from '../scenes/packageActions.js';
import { REACTIVE_ACTIONS } from '../operations/reactiveActions.js';
import { TRIGGER_GOVERNED_ACTIONS } from '../triggerActions.js';
import { FLOW_ACTIONS } from '../flows/chatActions.js';
import { DELETION_ACTIONS } from './deletionActions.js';
import { INTEGRATION_ACTIONS } from '../integrations/actions.js';
import { createIntent } from './intents.js';

// The one registry of chat-driven governed actions; unregistered names and invalid params parse to nothing.
export interface ParsedAction { action: string; params: Record<string, unknown> }

/** The verb's cell on the change grid: where the change lives and what it does to it. */
export interface DoorRoute {
  kind: string;
  verb: 'exists' | 'configure' | 'connect' | 'run';
}

// The verb's consent class and its refusal words live in consent.ts's CONSENT_POLICY, one row per verb.
export interface ActionSpec {
  name: string;
  escalationKind: string;
  /** One sentence of what actually happens when approved. */
  lands: string;
  route: DoorRoute;
  paramsSchema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  /** Executes the approved action — trusted kernel code only; parse time never executes anything. */
  execute(sql: postgres.Sql, ctx: { orgId: string; threadId: string; resolvedBy: string | null; createdBy: string; runId?: string | null }, params: Record<string, unknown>, driver?: ExecutionDriver): Promise<void>;
}

/** scene_revise's one executor — the DIALECT is the payload (Phase 7): the code compiles
 * against the live document to an eleven-op batch, then rides the same applyRevision wall.
 * A chat-raised edit is the assistant's; a work-run-raised edit belongs to that run. */
export async function executeSceneRevise(
  sql: postgres.Sql,
  input: { orgId: string; runId?: string | null; sceneSlug: string; code: string },
): Promise<ApplyResult> {
  const compiled = await compileSceneDialectAt(sql, { orgId: input.orgId, sceneSlug: input.sceneSlug, code: input.code });
  if (!compiled.ok) return { ok: false, errors: [...compiled.errors, DIALECT_FIX_SENTENCE] };
  if (compiled.ops.length === 0) {
    // The code equals the live screen: nothing to land, the current revision answers.
    const [scene] = await sql<{ head_revision: number }[]>`
      select head_revision from scenes where org_id = ${input.orgId} and slug = ${input.sceneSlug} and status != 'deleted'`;
    return { ok: true, revisionNo: scene?.head_revision ?? 0, duplicate: false, notes: ['no change - the code matches the live screen'] };
  }
  let actor = 'desk';
  if (typeof input.runId === 'string') {
    const [run] = await sql<{ kind: string }[]>`
      select kind from runs where id = ${input.runId}`;
    if (run && run.kind !== 'chat') actor = `run:${input.runId}`;
  }
  return applyUserRevision(sql, { orgId: input.orgId, sceneSlug: input.sceneSlug, actor, ops: compiled.ops });
}

// The registry feeds the one `act` door; the desk carries verb names only, full schemas serve on demand.
export const ACTION_REGISTRY: Record<string, ActionSpec> = {
  work_proposal: {
    name: 'work_proposal',
    escalationKind: 'work_proposal',
    lands: 'one agent run spawns owning the goal end to end; results land in this thread as it settles',
    route: { kind: 'work', verb: 'run' },
    paramsSchema: z.object({
      goal: z.string().min(1), rationale: z.string().min(1),
      /** Plain display name for this work; shown on the consent card. The desk owns every run. */
      role: z.string().min(2).max(40),
      brief: z.string().min(1).optional(),
      workspacePath: z.string().min(1).optional(),
      /** Target domains the work must open in the walled browser; the card always waits for a human. */
      browse: z.array(z.string().min(1)).max(5).optional(),
      /** Connected services the work must use (consented connections only). */
      connect: z.array(z.string().min(1)).max(3).optional(),
      /** The work drives the visible side-panel browser; only for browser work the user explicitly asked for. */
      browserVisible: z.boolean().optional(),
    }).strict(),
    async execute(): Promise<void> {
      // consent.ts lands work_proposal itself (spawnRun); registered here for parsing and vocabulary only.
      throw new Error('work_proposal lands via consent.ts, not the registry row');
    },
  },
  /** The plan door: a multi-system app ask raises the citizen grid; approval persists the plan and derives the mission. */
  app_plan: {
    name: 'app_plan',
    escalationKind: 'app_plan',
    lands: "the approved plan is the build's scope ceiling",
    route: { kind: 'project', verb: 'exists' },
    paramsSchema: z.object({
      tables: z.array(z.object({
        name: z.string().min(1),
        /** Column sketch: name -> plain type word. */
        rowSchema: z.record(z.string(), z.string()),
        provenance: z.enum(['seeded', 'user-entered', 'service', 'schedule']),
      }).strict()),
      screens: z.array(z.object({
        name: z.string().min(1),
        purpose: z.string().min(1),
        /** The tables this screen reads. */
        reads: z.array(z.string()),
      }).strict()),
      /** Flows and their triggers, one plain sentence each. */
      flows: z.array(z.string().min(1)),
      services: z.array(z.string().min(1)),
      /** The theme the plan names; approval stores it on the project. */
      theme: projectThemeSchema.optional(),
    }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = params as {
        tables: { name: string; rowSchema: Record<string, string>; provenance: 'seeded' | 'user-entered' | 'service' | 'schedule' }[];
        screens: { name: string; purpose: string; reads: string[] }[];
        flows: string[]; services: string[];
        theme?: ProjectTheme;
      };
      const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
      if (projectId === null) throw new Error('this thread has no project to plan');
      // The plan's theme lands on the project at approval.
      if (p.theme !== undefined) {
        await setProjectTheme(sql, { orgId: ctx.orgId, projectId, theme: p.theme, by: ctx.createdBy });
      }
      const planDoc = { tables: p.tables, screens: p.screens, flows: p.flows, services: p.services };
      // Append-only per project: the prior active revision is superseded, never deleted.
      const revision = await sql.begin(async (tx) => {
        const prior = await tx<{ revision: number }[]>`
          update app_plans set superseded_at = now()
          where org_id = ${ctx.orgId} and project_id = ${projectId} and superseded_at is null
          returning revision`;
        const rev = (prior[0]?.revision ?? 0) + 1;
        await tx`
          insert into app_plans (org_id, project_id, thread_id, revision, plan, approved_by)
          values (${ctx.orgId}, ${projectId}, ${ctx.threadId}, ${rev},
                  ${tx.json(planDoc as unknown as postgres.JSONValue)}, ${ctx.createdBy})`;
        return rev;
      }) as number;
      // Approval yields the mission: one part per plan row; an unplanned part cannot be added silently.
      const parts = [
        ...p.tables.map((t) => ({
          text: `Table '${t.name}'`,
          acceptance: `the '${t.name}' table exists with its planned columns (${t.provenance})`,
        })),
        ...p.screens.map((s) => ({
          text: `Screen '${s.name}' - ${s.purpose}`,
          acceptance: `the '${s.name}' screen renders${s.reads.length > 0 ? ` reading ${s.reads.join(', ')}` : ''}`,
        })),
        ...p.flows.map((f) => ({
          text: `Flow - ${f}`,
          acceptance: 'the flow exists wired and enabled',
        })),
        ...p.services.map((v) => ({
          text: `Service '${v}'`,
          acceptance: `the '${v}' service is placed and connected`,
        })),
      ];
      if (parts.length > 0) {
        await createIntent(sql, { orgId: ctx.orgId, threadId: ctx.threadId, parts, createdBy: ctx.createdBy });
      }
      await emitEvent(sql, {
        orgId: ctx.orgId, actor: 'kernel.consent', type: 'plan.approved',
        payload: { projectId, revision, threadId: ctx.threadId, parts: parts.length },
      });
    },
  },
  // One consent card creates the project AND its standing folder grant; later work under the subtree never re-asks.
  create_project: {
    name: 'create_project',
    escalationKind: 'create_project',
    lands: 'the project and its standing folder grant are created in one consent',
    route: { kind: 'project', verb: 'exists' },
    paramsSchema: z.object({
      path: z.string().min(1),
      name: z.string().min(1),
      verifyCommand: z.string().min(1).nullable().optional(),
    }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({
        path: z.string().min(1), name: z.string().min(1),
        verifyCommand: z.string().min(1).nullable().optional(),
      }).parse(params);
      const { projectId } = await createProject(sql, {
        orgId: ctx.orgId, path: p.path, name: p.name,
        verifyCommand: p.verifyCommand ?? null, createdBy: ctx.createdBy,
      });
      await writeConsentGrant(sql, {
        orgId: ctx.orgId, subject: `folder:${p.path.replace(/[\\/]+$/, '')}`,
        grantedBy: ctx.createdBy, class: 'ask-once', projectId,
      });
    },
  },
  /** Renames this thread's project only; auto in both modes. */
  rename_project: {
    name: 'rename_project',
    escalationKind: 'rename_project',
    lands: 'the project of this thread is renamed; auto in both modes',
    route: { kind: 'project', verb: 'configure' },
    paramsSchema: z.object({ name: z.string().min(1).max(60) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ name: z.string().min(1).max(60) }).parse(params);
      // Every thread carries a project — only the row's existence needs checking.
      const [row] = await sql<{ project_id: string }[]>`
        select project_id from threads where id = ${ctx.threadId} and org_id = ${ctx.orgId}`;
      if (!row) throw new Error('this thread has no project to rename');
      await renameProject(sql, { orgId: ctx.orgId, projectId: row.project_id, name: p.name, by: ctx.createdBy });
    },
  },
  /** Settings by chat: an agentic thread must never lift its own caps. */
  org_settings: {
    name: 'org_settings',
    escalationKind: 'org_settings',
    lands: 'the settings patch applies after the card; invalid patches throw',
    route: { kind: 'org', verb: 'configure' },
    paramsSchema: z.object({ patch: z.record(z.unknown()) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ patch: z.record(z.unknown()) }).parse(params);
      // orgConfigSchema validates the merged result inside setOrgConfig — junk patches throw.
      await setOrgConfig(sql, ctx.orgId, p.patch, { updatedBy: ctx.createdBy });
    },
  },
  /** Thread mode by chat: a thread must never self-promote to auto. */
  thread_mode: {
    name: 'thread_mode',
    escalationKind: 'thread_mode',
    lands: 'the thread mode flips after the card; a thread never self-promotes',
    route: { kind: 'org', verb: 'configure' },
    paramsSchema: z.object({ mode: z.enum(['ask', 'auto']) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ mode: z.enum(['ask', 'auto']) }).parse(params);
      await setThreadMode(sql, { orgId: ctx.orgId, threadId: ctx.threadId, mode: p.mode });
    },
  },
  /** Connect an outside service by chat; params carry the service id only — the token goes straight to the vault, never the model. */
  connect_service: {
    name: 'connect_service',
    escalationKind: 'connect_service',
    lands: 'the card collects a dev-tool token into the vault for work runs; app services go through integrations_place',
    route: { kind: 'service', verb: 'exists' },
    paramsSchema: z.object({ service: z.string().min(1) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ service: z.string().min(1) }).parse(params);
      await addConnection(sql, { orgId: ctx.orgId, serviceId: p.service, createdBy: ctx.createdBy });
    },
  },
  /** Org component definitions enter the library through consent; deep grammar validation lives in the params schema. */
  component_proposal: {
    name: 'component_proposal',
    escalationKind: 'component_proposal',
    lands: 'the component definition enters the library after the preview card; a revision is the same name at version+1 with a migration map',
    route: { kind: 'component', verb: 'exists' },
    paramsSchema: z.object({
      definition: z.record(z.string(), z.unknown()),
      migration: z.object({
        renamed: z.record(z.string(), z.string()).optional(),
        removed: z.array(z.string()).optional(),
        defaultChanged: z.array(z.string()).optional(),
      }).strict().optional(),
      /** Provenance ref when this definition forks an existing one (component.forked event). */
      forkOf: z.string().min(1).optional(),
    }).strict().superRefine((val, ctx) => {
      const deep = validateOrgDefinition(val.definition);
      if (!deep.ok) {
        for (const e of deep.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definition'], message: e });
      }
    }) as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { definition: unknown; migration?: ComponentMigrationMap; forkOf?: string };
      const created = await createOrgComponent(sql, {
        orgId: ctx.orgId,
        // The mint lands in the asking thread's project.
        projectId: await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId }),
        definition: p.definition, migration: p.migration,
        createdBy: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!created.ok) throw new Error(`component not published: ${created.errors.join(' · ')}`);
      if (p.forkOf) {
        await emitEvent(sql, {
          orgId: ctx.orgId, actor: 'kernel.scenes', type: 'component.forked',
          payload: { from: p.forkOf, to: created.ref },
        });
      }
    },
  },
  /** A component file crosses the org boundary through the same gate as authoring. */
  import_component: {
    name: 'import_component',
    escalationKind: 'import_component',
    lands: 'the file definition re-validates through the same gate and lands in this project',
    route: { kind: 'component', verb: 'exists' },
    paramsSchema: z.object({
      file: z.record(z.string(), z.unknown()),
      shapeMapping: z.record(z.string(), z.string()).optional(),
    }).strict().superRefine((val, ctx) => {
      const deep = validateComponentFile(val.file);
      if (!deep.ok) {
        for (const e of deep.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['file'], message: e });
      }
    }) as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { file: unknown; shapeMapping?: Record<string, string> };
      const imported = await importComponent(sql, {
        orgId: ctx.orgId,
        // The imported copy lands in the asking thread's project.
        projectId: await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId }),
        file: p.file, shapeMapping: p.shapeMapping,
        createdBy: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!imported.ok) throw new Error(`component not imported: ${imported.errors.join(' · ')}`);
    },
  },
  // Surgical scene edits through consent; the payload is DIALECT TEXT (the one authoring
  // encoding) - it compiles to the op grammar and the same applyRevision wall lands it.
  scene_revise: {
    name: 'scene_revise',
    escalationKind: 'scene_revise',
    lands: 'the dialect code compiles against the live screen and lands at a named revision immediately; it can never declare a binding',
    route: { kind: 'screen', verb: 'configure' },
    paramsSchema: z.object({
      sceneSlug: z.string().min(1),
      /** Why, in user words — the card's headline beside the change. */
      intent: z.string().min(5),
      /** The screen in dialect text; what is absent is removed, a '...' line keeps a region. */
      code: z.string().min(1).max(300_000),
    }).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { sceneSlug: string; intent: string; code: string };
      const res = await executeSceneRevise(sql, { orgId: ctx.orgId, runId: ctx.runId ?? null, sceneSlug: p.sceneSlug, code: p.code });
      if (!res.ok) throw new Error(`scene_revise rejected by the wall: ${res.errors.join('; ')}`);
    },
  },
  ...TAB_ACTIONS,
  ...OPERATION_ACTIONS,
  ...REACTIVE_ACTIONS,
  ...TRIGGER_GOVERNED_ACTIONS,
  ...FLOW_ACTIONS,
  ...INTEGRATION_ACTIONS,
  ...PACKAGE_ACTIONS,
  ...DELETION_ACTIONS,
};
