import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { SpawnedRun } from '@tent-nocode/kernel';
import { toKernelPort, type KernelPort } from './kernelPort.js';
import type { RunnerConfig } from './runner.js';

// GUTTED at the AI-surface rebuild (Phase 2): the per-run MCP mount serves the
// tools.ts roster - one server, one flat list. The browse/panel/ext lanes keep
// their own servers. Never-fail: a mounting hiccup degrades to a tool-less run.

export interface MountResult {
  /** The tools.ts roster server (CLI-lane children); the API loop mounts in-process. */
  toolsMounted: boolean;
  browseToolsMounted: boolean;
  /** The visible-browser server (desk turns always; work runs under reach). */
  panelBrowserMounted: boolean;
  /** The draft-render lane (the look tool), scene-build runs and chat turns. */
  sceneSnapshotMounted: boolean;
  /** The run's project; null = a project-less run. */
  notesProjectId: string | null;
  /** External MCP services mounted from the org connections registry. */
  externalMcpMounted: string[];
  mcpConfigFile: string | null;
  /** The unguessable temp dir holding mcp.json; caller cleans it up. */
  mcpConfigDir: string | null;
}

export async function mountRunServers(
  db: postgres.Sql | KernelPort, cfg: RunnerConfig, claim: SpawnedRun, workspaceDir: string,
): Promise<MountResult> {
  const port = toKernelPort(db);
  const out: MountResult = {
    toolsMounted: false, browseToolsMounted: false, panelBrowserMounted: false,
    sceneSnapshotMounted: false, notesProjectId: null, externalMcpMounted: [],
    mcpConfigFile: null, mcpConfigDir: null,
  };
  // Resolve the run's project: thread first, consented-folder derivation second.
  try {
    if (claim.threadId !== null) {
      out.notesProjectId = await port.getThreadProjectId(claim.orgId, claim.threadId);
    }
    if (out.notesProjectId === null && claim.workspacePath !== null) {
      out.notesProjectId = (await port.findProjectForPath(claim.orgId, claim.workspacePath))?.id ?? null;
    }
  } catch { out.notesProjectId = null; }
  // Scene-build identity rides the run input.
  const sceneBuildSlugRaw = (claim.input?.['sceneBuild'] as { sceneSlug?: unknown } | undefined)?.sceneSlug;
  const sceneBuildSlug = typeof sceneBuildSlugRaw === 'string' && sceneBuildSlugRaw.length > 0 ? sceneBuildSlugRaw : null;
  // Granted browse domains: an env-bound allowlist the model can never widen.
  const reachNames = (prefix: string): string[] => claim.permissionRules.flatMap((r) =>
    r.effect !== 'deny' && r.pattern.startsWith(prefix) && !r.pattern.includes('*')
      ? [r.pattern.slice(prefix.length)]
      : [],
  ).filter(Boolean);
  const browseDomains = reachNames('browse:');
  const connectorNames = reachNames('connect:');
  try {
    const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    // The driver's child env strips DATABASE_URL, so spawned servers need it passed here.
    const dbEnv: Record<string, string> =
      process.env['DATABASE_URL'] !== undefined ? { DATABASE_URL: process.env['DATABASE_URL'] } : {};
    // The draft-render grant registers before any server can relay a capture;
    // build runs stay slug-bound, chat turns get the org-wide '*' grant.
    const snapshotOn = (sceneBuildSlug !== null || claim.kind === 'chat') && cfg.browseChannel !== undefined;
    if (snapshotOn) {
      cfg.registerSceneSnapshotGrant?.(claim.runId, { orgId: claim.orgId, sceneSlug: sceneBuildSlug ?? '*' });
      out.sceneSnapshotMounted = true;
    }
    // THE ROSTER: one server serving tools.ts, on every CLI-lane run.
    if (cfg.toolsMcpCommand !== undefined && cfg.toolsMcpCommand.length > 0) {
      const [tcmd, ...targs] = cfg.toolsMcpCommand;
      servers['tent-nocode-tools'] = {
        command: tcmd as string, args: targs,
        env: {
          TOOLS_MCP_ORG: claim.orgId, TOOLS_MCP_RUN_ID: claim.runId, ELECTRON_RUN_AS_NODE: '1',
          TOOLS_MCP_KIND: claim.kind, TOOLS_MCP_WORKSPACE: workspaceDir,
          ...(claim.threadId !== null ? { TOOLS_MCP_THREAD_ID: claim.threadId } : {}),
          ...(out.notesProjectId !== null ? { TOOLS_MCP_PROJECT: out.notesProjectId } : {}),
          ...(snapshotOn && cfg.browseChannel !== undefined
            ? { TOOLS_MCP_SNAPSHOT_URL: cfg.browseChannel.url, TOOLS_MCP_SNAPSHOT_TOKEN: cfg.browseChannel.token }
            : {}),
          ...dbEnv,
        },
      };
      out.toolsMounted = true;
    }
    // The walled browser mounts only for a browse-scoped work run with granted domains;
    // futility caps and the allowlist ride the env, never a tool arg.
    if (claim.kind === 'work' && browseDomains.length > 0
        && cfg.browserMcpCommand !== undefined && cfg.browserMcpCommand.length > 0
        && cfg.browseChannel !== undefined) {
      const fut = await port.getOrgConfig(claim.orgId).then((c) => c.futility).catch(() => ({
        maxPagesPerRun: 20, minContentBytes: 200, lowContentLimit: 4,
      }));
      const [bcmd, ...bargs] = cfg.browserMcpCommand;
      servers['tent-nocode-browser'] = {
        command: bcmd as string, args: bargs,
        env: {
          BROWSE_MCP_ORG: claim.orgId, BROWSE_MCP_RUN_ID: claim.runId,
          BROWSE_CHANNEL_URL: cfg.browseChannel.url, BROWSE_CHANNEL_TOKEN: cfg.browseChannel.token,
          BROWSE_ALLOWED: browseDomains.join(','),
          BROWSE_MAX_PAGES: String(fut.maxPagesPerRun),
          BROWSE_MIN_CONTENT_BYTES: String(fut.minContentBytes),
          BROWSE_LOW_CONTENT_LIMIT: String(fut.lowContentLimit),
          ELECTRON_RUN_AS_NODE: '1',
        },
      };
      out.browseToolsMounted = true;
      // Register the authoritative allowlist with the host before any navigation.
      cfg.registerBrowseGrant?.(claim.runId, browseDomains);
    }
    // Visible-browser verbs: chat always, work runs only under a consented panel:visible
    // rule. The lease in main walls every verb; mounting grants nothing by itself.
    if ((claim.kind === 'chat' || reachNames('panel:').includes('visible'))
        && cfg.panelBrowserMcpCommand !== undefined && cfg.panelBrowserMcpCommand.length > 0
        && cfg.browseChannel !== undefined) {
      const [pcmd, ...pargs] = cfg.panelBrowserMcpCommand;
      servers['tent-nocode-panelbrowser'] = {
        command: pcmd as string, args: pargs,
        env: {
          PANEL_MCP_ORG: claim.orgId, PANEL_MCP_RUN_ID: claim.runId,
          PANEL_CHANNEL_URL: cfg.browseChannel.url, PANEL_CHANNEL_TOKEN: cfg.browseChannel.token,
          ELECTRON_RUN_AS_NODE: '1',
        },
      };
      out.panelBrowserMounted = true;
    }
    // External MCP servers from the org connections registry. The command was snapshot
    // at consent; the vault secret decrypts here and rides the server env - the model
    // never sees a value. No vault secret means the service stays unavailable this run.
    if (claim.kind === 'work' && connectorNames.length > 0 && cfg.resolveSecret !== undefined) {
      const rows = await port.listConnections(claim.orgId).catch(() => []);
      for (const name of connectorNames) {
        const conn = rows.find((c) => c.serviceId === name);
        if (!conn || conn.command.length === 0) continue;
        const secret = await cfg.resolveSecret(claim.orgId, conn.secretName).catch(() => null);
        if (!secret) continue;
        const [xcmd, ...xargs] = conn.command;
        servers[`ext-${conn.serviceId}`] = {
          command: xcmd as string, args: xargs,
          env: { [conn.secretEnv]: secret },
        };
        out.externalMcpMounted.push(conn.serviceId);
      }
    }
    if (Object.keys(servers).length > 0) {
      // The config carries secrets, so it must live outside the model's workspace;
      // write it to an unguessable temp dir and hand the CLI its absolute path.
      out.mcpConfigDir = await mkdtemp(join(tmpdir(), 'tent-nocode-mcp-'));
      out.mcpConfigFile = join(out.mcpConfigDir, 'mcp.json');
      await writeFile(out.mcpConfigFile, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
    }
  } catch (err) {
    out.toolsMounted = false;
    console.error('tool mounting skipped for run', claim.runId, err instanceof Error ? err.message : String(err));
  }
  return out;
}
