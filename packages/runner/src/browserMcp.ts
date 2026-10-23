import { z } from 'zod';

// The tent-nocode-browser MCP server: relays navigations to the host over the authed loopback
// channel and applies the futility brake. The model can never widen the domain allowlist.

export interface BrowseFutility {
  maxPagesPerRun: number;
  minContentBytes: number;
  lowContentLimit: number;
}

export interface BrowseDeps {
  /** Relays to the loopback channel; resolves the page's readable text and byte length. */
  navigate: (url: string) => Promise<{ text: string; contentBytes: number }>;
  allowedDomains: string[];
  futility: BrowseFutility;
  /** Cap on returned text (chars). */
  maxTextChars?: number;
}

const WALL_REPORT =
  'BROWSE WALL: the last pages returned little or no readable content — they are almost certainly '
  + 'JavaScript-gated, bot-walled, or behind auth, and more fetches will not help. STOP browsing now. '
  + 'Report to the user plainly what you were able to reach and what you could not, and (if the '
  + 'source has a real API) suggest a connector instead. Do not claim a number you did not actually read.';

/** Hostname of a plain http/https URL, or null; other schemes must never reach the browser host. */
function hostname(url: string): string | null {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : null;
  } catch { return null; }
}

/** Pure tool core; fresh counters per run, testable with a fake navigate. */
export function buildBrowseToolHandlers(deps: BrowseDeps): {
  browse_open: (args: { url: string }) => Promise<string>;
} {
  const allowed = new Set(deps.allowedDomains);
  const cap = deps.maxTextChars ?? 12_000;
  let pagesOpened = 0;
  let lowContentPages = 0;

  return {
    async browse_open({ url }): Promise<string> {
      if (pagesOpened >= deps.futility.maxPagesPerRun) return WALL_REPORT;
      const host = hostname(url);
      if (host === null || !allowed.has(host)) {
        return `browse refused: "${host ?? url}" is not a granted domain. Granted: ${
          deps.allowedDomains.join(', ') || '(none)'}.`;
      }
      let result: { text: string; contentBytes: number };
      try {
        result = await deps.navigate(url);
      } catch (err) {
        return `browse failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      pagesOpened += 1;
      if (result.contentBytes < deps.futility.minContentBytes) {
        lowContentPages += 1;
        if (lowContentPages >= deps.futility.lowContentLimit) return WALL_REPORT;
        return `(${host}) returned little readable content (${result.contentBytes} bytes). `
          + `${deps.futility.lowContentLimit - lowContentPages} low-content page(s) left before the wall report.`;
      }
      const text = result.text.length > cap ? `${result.text.slice(0, cap)}\n…[truncated]` : result.text;
      return `(${host}, ${result.contentBytes} bytes)\n${text}`;
    },
  };
}

const intFromEnv = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};

/** Starts the stdio MCP server; org and channel come from this process's env. */
export async function startBrowserMcpServer(): Promise<void> {
  const orgId = process.env['BROWSE_MCP_ORG'];
  if (!z.string().uuid().safeParse(orgId).success) {
    console.error('browserMcp: BROWSE_MCP_ORG must be a valid org UUID'); process.exit(1); return;
  }
  const channelUrl = process.env['BROWSE_CHANNEL_URL'];
  const channelToken = process.env['BROWSE_CHANNEL_TOKEN'];
  const runId = process.env['BROWSE_MCP_RUN_ID'] ?? '';
  if (!channelUrl || !channelToken || !runId) {
    console.error('browserMcp: BROWSE_CHANNEL_URL, BROWSE_CHANNEL_TOKEN, BROWSE_MCP_RUN_ID all required');
    process.exit(1); return;
  }
  const allowedDomains = (process.env['BROWSE_ALLOWED'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const browseTools = buildBrowseToolHandlers({
    allowedDomains,
    futility: {
      maxPagesPerRun: intFromEnv('BROWSE_MAX_PAGES', 20),
      minContentBytes: intFromEnv('BROWSE_MIN_CONTENT_BYTES', 200),
      lowContentLimit: intFromEnv('BROWSE_LOW_CONTENT_LIMIT', 4),
    },
    navigate: async (url) => {
      const res = await fetch(`${channelUrl}/navigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${channelToken}` },
        // The channel enforces the run's registered grant; the allowlist is not sent here.
        body: JSON.stringify({ runId, url }),
      });
      if (!res.ok) throw new Error(`channel ${res.status}`);
      return (await res.json()) as { text: string; contentBytes: number };
    },
  });

  const server = new McpServer({ name: 'tent-nocode-browser', version: '0.1.0' });
  server.registerTool(
    'browse_open',
    {
      description: 'Open a URL in a real browser (renders JavaScript) and return the page\'s readable '
        + 'text. Only granted domains are reachable. If a page returns little content it is bot-walled '
        + '— after a few such pages you will be told to STOP and report the wall instead of grinding.',
      inputSchema: { url: z.string() },
    },
    async (args) => ({ content: [{ type: 'text', text: await browseTools.browse_open(args) }] }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('runner/src/browserMcp.ts') ?? false;
if (isDirect) void startBrowserMcpServer();
