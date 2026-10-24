import { z } from 'zod';

// The visible-browser MCP server: every verb relays to the panel driver in main over
// the authed loopback channel. The lease lives in main; without one every relay fails.

export interface PanelDeps {
  /** POST a /panel/* route on the loopback channel; resolves the parsed JSON body. */
  call: (route: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export interface PanelToolResult {
  text?: string;
  image?: { mime: string; base64: string };
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Pure handler layer, unit-testable with a fake call. */
export function buildPanelToolHandlers(deps: PanelDeps): Record<string, (args: never) => Promise<PanelToolResult>> {
  const call = async (route: string, payload: Record<string, unknown>): Promise<PanelToolResult> => {
    const out = await deps.call(route, payload);
    const o = out as { ok?: boolean; error?: string; page?: string; mime?: string; base64?: string };
    if (o && o.ok === false) return { text: `refused: ${o.error ?? 'unknown'}` };
    if (o && typeof o.page === 'string') return { text: o.page };
    if (o && typeof o.base64 === 'string' && typeof o.mime === 'string') {
      return { image: { mime: o.mime, base64: o.base64 } };
    }
    return { text: asText(out) };
  };
  return {
    acquire_browser: (a: { task: string }) => call('/panel/acquire', { task: a.task }),
    open_page: (a: { url: string }) => call('/panel/open', { url: a.url }),
    read_page: () => call('/panel/read', {}),
    screenshot: () => call('/panel/screenshot', {}),
    click: (a: { selector?: string; index?: number; x?: number; y?: number }) => call('/panel/click', { ...a }),
    type_text: (a: { selector?: string; index?: number; text: string; submit?: boolean }) => call('/panel/type', { ...a }),
    scroll: (a: { dy: number }) => call('/panel/scroll', { dy: a.dy }),
    wait: (a: { ms: number }) => call('/panel/wait', { ms: a.ms }),
    hand_back: (a: { reason: string }) => call('/panel/handback', { reason: a.reason }),
    release_browser: () => call('/panel/release', {}),
  } as Record<string, (args: never) => Promise<PanelToolResult>>;
}

/** Start the stdio MCP server; org and channel come from this process's env. */
export async function startPanelBrowserMcpServer(): Promise<void> {
  const orgId = process.env['PANEL_MCP_ORG'];
  if (!z.string().uuid().safeParse(orgId).success) {
    console.error('panelBrowserMcp: PANEL_MCP_ORG must be a valid org UUID'); process.exit(1); return;
  }
  const runId = process.env['PANEL_MCP_RUN_ID'] ?? '';
  const channelUrl = process.env['PANEL_CHANNEL_URL'] ?? '';
  const channelToken = process.env['PANEL_CHANNEL_TOKEN'] ?? '';
  if (runId === '' || channelUrl === '' || channelToken === '') {
    console.error('panelBrowserMcp: PANEL_MCP_RUN_ID, PANEL_CHANNEL_URL, PANEL_CHANNEL_TOKEN are required');
    process.exit(1); return;
  }

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const handlers = buildPanelToolHandlers({
    call: async (route, payload) => {
      const res = await fetch(`${channelUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${channelToken}` },
        body: JSON.stringify({ runId, orgId, ...payload }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `channel ${res.status}`);
      }
      return res.json();
    },
  });

  const server = new McpServer({ name: 'nodeloom-panelbrowser', version: '0.1.0' });
  const text = (h: (args: never) => Promise<PanelToolResult>) => async (args: unknown) => {
    const out = await h(args as never);
    if (out.image) {
      return { content: [{ type: 'image' as const, data: out.image.base64, mimeType: out.image.mime }] };
    }
    return { content: [{ type: 'text' as const, text: out.text ?? '' }] };
  };

  server.registerTool('acquire_browser', {
    description: 'Take the visible browser in the side panel for ONE user-asked task. The user sees '
      + 'and can revoke at any moment. Only call this for browser work the user explicitly asked for; '
      + 'release_browser when the task is done.',
    inputSchema: { task: z.string().min(1).max(200) },
  }, text(handlers['acquire_browser']!));
  server.registerTool('open_page', {
    description: 'Navigate the leased visible browser to a URL and return the landed url + title.',
    inputSchema: { url: z.string().min(1) },
  }, text(handlers['open_page']!));
  server.registerTool('read_page', {
    description: 'Read the current page: url, title, visible text, and indexed interactables '
      + '(use the [n] index with click/type_text). Re-read after any navigation or click.',
    inputSchema: {},
  }, text(handlers['read_page']!));
  server.registerTool('screenshot', {
    description: 'Screenshot the visible browser page (what the user also sees).',
    inputSchema: {},
  }, text(handlers['screenshot']!));
  server.registerTool('click', {
    description: 'Click an element by read_page index, CSS selector, or x/y point.',
    inputSchema: {
      index: z.number().int().min(0).optional(), selector: z.string().optional(),
      x: z.number().optional(), y: z.number().optional(),
    },
  }, text(handlers['click']!));
  server.registerTool('type_text', {
    description: 'Focus an input (by index or selector) and type text; submit presses Enter. '
      + 'Password fields are refused — call hand_back so the user types credentials themselves.',
    inputSchema: {
      index: z.number().int().min(0).optional(), selector: z.string().optional(),
      text: z.string().max(4000), submit: z.boolean().optional(),
    },
  }, text(handlers['type_text']!));
  server.registerTool('scroll', {
    description: 'Scroll the page vertically by dy pixels (negative = up).',
    inputSchema: { dy: z.number() },
  }, text(handlers['scroll']!));
  server.registerTool('wait', {
    description: 'Wait up to 10s for the page to settle.',
    inputSchema: { ms: z.number().int().min(0).max(10000) },
  }, text(handlers['wait']!));
  server.registerTool('hand_back', {
    description: 'Hand the browser to the USER for a step only they may do (passwords, payments, '
      + 'challenges). Your calls pause until they click resume; then read_page fresh — never assume '
      + 'what they did.',
    inputSchema: { reason: z.string().min(1).max(200) },
  }, text(handlers['hand_back']!));
  server.registerTool('release_browser', {
    description: 'Release the browser lease when the asked task is done.',
    inputSchema: {},
  }, text(handlers['release_browser']!));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
