import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type postgres from 'postgres';
import { emitEvent } from './events.js';

// Projects: a folder granted once as a subtree, with a name and an optional verifyCommand.

// THE THEME (AI-surface rebuild, Phase 10): the one token file every component references,
// stored on the project. Written by the theme block of the project dialect, by app_plan
// approval, by create_view (the no-plan fast path) and by the brief tool; read by the
// dialect lint, the scene host page (buildThemeCss) and every scene-editing run's compose tail.

/** One color value: a hex literal, rgb()/hsl(), or a CSS color word. */
const themeColor = z.string().min(1).max(60);

/** The brief (v0's design brief, ours in shape): stored beside the theme; the theme's colors derive from its palette. */
export const projectBriefSchema = z.object({
  mood: z.string().min(1).max(400),
  /** The theme tokens with values: every color name, plus radius/glow/shadow when chosen. */
  palette: z.record(z.string(), z.union([z.string(), z.number()])),
  typePair: z.string().min(1).max(120),
  density: z.string().min(1).max(40),
  layoutAnchor: z.string().min(1).max(400),
  signatureMove: z.string().min(1).max(400),
  imageryStance: z.literal('none'),
  contentTone: z.string().min(1).max(400),
  do: z.array(z.string().min(1).max(200)).max(12),
  dont: z.array(z.string().min(1).max(200)).max(12),
}).strict();
export type ProjectBrief = z.infer<typeof projectBriefSchema>;

export const projectThemeSchema = z.object({
  // The surface ladder (outside the color budget).
  background: themeColor,
  foreground: themeColor,
  card: themeColor,
  cardForeground: themeColor,
  cardRaised: themeColor,
  muted: themeColor,
  mutedForeground: themeColor,
  // The brand color and its foreground.
  primary: themeColor,
  primaryForeground: themeColor,
  // The one accent and its foreground.
  accent: themeColor,
  accentForeground: themeColor,
  border: themeColor,
  ring: themeColor,
  // Status hues (outside the color budget).
  green: themeColor,
  amber: themeColor,
  red: themeColor,
  /** The corner radius in px (the small control radius; cards and overlays step up from it). */
  radius: z.number().int().min(0).max(40),
  fontSans: z.string().min(1).max(80),
  fontMono: z.string().min(1).max(80),
  /** A lighter primary for glows (Lovable's --primary-glow); a color. */
  glow: themeColor.optional(),
  /** The elegant shadow, one CSS box-shadow value. */
  shadow: z.string().min(1).max(200).optional(),
  /** The one signature move, one sentence. */
  signature: z.string().min(1).max(400),
  /** One plain density word (e.g. "airy", "dense"). */
  density: z.string().min(1).max(40),
  /** Named widths the screens' `at` blocks may address; absent = the contract's two (phone, tablet). */
  breakpoints: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), z.object({
    minWidth: z.number().int().min(0).optional(), maxWidth: z.number().int().min(1).optional(),
  }).strict()).optional(),
  brief: projectBriefSchema.optional(),
}).strict();
export type ProjectTheme = z.infer<typeof projectThemeSchema>;

/** The theme's color field names, in token order (the lint's vocabulary and the host page's mapping). */
export const THEME_COLOR_NAMES = [
  'background', 'foreground', 'card', 'cardForeground', 'cardRaised', 'muted', 'mutedForeground',
  'primary', 'primaryForeground', 'accent', 'accentForeground', 'border', 'ring', 'green', 'amber', 'red', 'glow',
] as const;

/** Commits the project's theme; overwrites deliberately (a new plan revision or brief re-commits). A theme written without a brief keeps the stored brief. */
export async function setProjectTheme(
  sql: postgres.Sql, input: { orgId: string; projectId: string; theme: ProjectTheme; by: string },
): Promise<void> {
  const theme = projectThemeSchema.parse(input.theme);
  if (theme.brief === undefined) {
    const prior = await readProjectTheme(sql, input.orgId, input.projectId);
    if (prior?.brief !== undefined) theme.brief = prior.brief;
  }
  const rows = await sql<{ id: string }[]>`
    update projects set theme = ${sql.json(theme)}
    where id = ${input.projectId} and org_id = ${input.orgId} and archived_at is null
    returning id`;
  if (!rows[0]) throw new Error(`project not found: ${input.projectId}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.projects', type: 'project.theme_committed',
    payload: { projectId: input.projectId, theme, by: input.by },
  });
}

/** The project's theme, or null; a malformed stored value reads as none. */
export async function readProjectTheme(
  sql: postgres.Sql, orgId: string, projectId: string,
): Promise<ProjectTheme | null> {
  const [row] = await sql<{ theme: unknown }[]>`
    select theme from projects where id = ${projectId} and org_id = ${orgId}`;
  const parsed = projectThemeSchema.safeParse(row?.theme);
  return parsed.success ? parsed.data : null;
}

export interface ProjectRow {
  id: string;
  orgId: string;
  /** Null = a chat-born project with no folder or grant semantics. */
  path: string | null;
  name: string;
  /** What the project surfaces as on human surfaces; null reads as 'app'. */
  kind: 'app' | 'website' | null;
  verifyCommand: string | null;
  createdBy: string;
  createdAt: string;
}

/** Normalized subtree key: lowercase, backslash separators, no trailing separator. */
function normProjectPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** True when `path` is `root` itself or sits anywhere under it. */
export function pathIsWithin(root: string, path: string): boolean {
  const r = normProjectPath(root);
  const p = normProjectPath(path);
  return p === r || p.startsWith(r + '\\');
}

export async function createProject(
  sql: postgres.Sql,
  input: { orgId: string; path: string; name: string; verifyCommand?: string | null; createdBy: string },
): Promise<{ projectId: string }> {
  if (!isAbsolute(input.path)) {
    throw new Error(`project path must be an absolute folder path (got '${input.path}')`);
  }
  const [row] = await sql<{ id: string }[]>`
    insert into projects (org_id, path, name, verify_command, created_by)
    values (${input.orgId}, ${input.path}, ${input.name}, ${input.verifyCommand ?? null}, ${input.createdBy})
    returning id`;
  if (!row) throw new Error('project insert returned no row');
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.projects', type: 'project.created',
    payload: { projectId: row.id, path: input.path, name: input.name, verifyCommand: input.verifyCommand ?? null },
  });
  return { projectId: row.id };
}

/** The unarchived project whose folder is `path` or an ancestor of it, or null; pathless projects never match. */
export async function findProjectForPath(
  sql: postgres.Sql, orgId: string, path: string,
): Promise<ProjectRow | null> {
  const rows = await listProjects(sql, orgId);
  return rows.find((p) => p.path !== null && pathIsWithin(p.path, path)) ?? null;
}

/** Creates a pathless chat-born project: zero reach, so no consent card; the name is provisional. */
export async function createChatProject(
  sql: postgres.Sql,
  input: { orgId: string; name: string; createdBy: string; kind?: 'app' | 'website' },
): Promise<{ projectId: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into projects (org_id, path, name, kind, verify_command, created_by)
    values (${input.orgId}, ${null}, ${input.name}, ${input.kind ?? null}, ${null}, ${input.createdBy})
    returning id`;
  if (!row) throw new Error('project insert returned no row');
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.projects', type: 'project.created',
    payload: { projectId: row.id, path: null, name: input.name, kind: input.kind ?? null, born: 'chat' },
  });
  return { projectId: row.id };
}

/** Renames a project; renders nothing, the rail re-reads. */
export async function renameProject(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; name: string; by: string },
): Promise<void> {
  const name = input.name.trim();
  if (name === '') throw new Error('project name must not be empty');
  const rows = await sql<{ id: string }[]>`
    update projects set name = ${name}
    where id = ${input.projectId} and org_id = ${input.orgId} and archived_at is null
    returning id`;
  if (!rows[0]) throw new Error(`project not found: ${input.projectId}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.projects', type: 'project.renamed',
    payload: { projectId: input.projectId, name, by: input.by },
  });
}

export async function listProjects(sql: postgres.Sql, orgId: string): Promise<ProjectRow[]> {
  const rows = await sql<{ id: string; org_id: string; path: string; name: string; kind: 'app' | 'website' | null; verify_command: string | null; created_by: string; created_at: Date }[]>`
    select id, org_id, path, name, kind, verify_command, created_by, created_at from projects
    where org_id = ${orgId} and archived_at is null order by created_at desc`;
  return rows.map((r) => ({
    id: r.id, orgId: r.org_id, path: r.path, name: r.name, kind: r.kind, verifyCommand: r.verify_command,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  }));
}

/** Renders the project's recent work runs with their file-change records as a context section; null when none. */
export async function projectStateSection(
  sql: postgres.Sql, orgId: string, project: ProjectRow, limit = 5,
): Promise<string | null> {
  const work = await sql<{ id: string; status: string; prompt: string; workspace_path: string }[]>`
    select id, status, coalesce(prompt, '') as prompt, workspace_path from runs
    where org_id = ${orgId} and kind = 'work' and workspace_path is not null
    order by created_at desc, id desc limit 30`;
  const projectRuns = project.path === null
    ? []
    : work.filter((j) => pathIsWithin(project.path!, j.workspace_path)).slice(0, limit);
  if (projectRuns.length === 0) return null;

  const ids = projectRuns.map((j) => j.id);
  const evs = await sql<{ payload: { runId?: string; created?: number; modified?: number; deleted?: number; sample?: string[] } }[]>`
    select payload from events
    where org_id = ${orgId} and type = 'run.workspace_changes' and payload->>'runId' = any(${ids}::text[])
    order by id desc`;
  const latestByRun = new Map<string, { created?: number; modified?: number; deleted?: number; sample?: string[] }>();
  for (const e of evs) {
    const runId = e.payload.runId;
    if (typeof runId === 'string' && !latestByRun.has(runId)) latestByRun.set(runId, e.payload);
  }

  const lines = projectRuns.map((j) => {
    const goal = j.prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
    const c = latestByRun.get(j.id);
    const changes = c
      ? ` — created ${c.created ?? 0}, modified ${c.modified ?? 0}, deleted ${c.deleted ?? 0}`
        + (c.sample && c.sample.length > 0 ? `: ${c.sample.slice(0, 5).join(', ')}` : '')
      : '';
    return `- [${j.status}] ${goal}${changes}`;
  });
  return [`PROJECT STATE (${project.name} — ${project.path}; recent work, newest first):`, ...lines].join('\n');
}
