/**
 * Tool caption labels (the one display map): every activity step translates to a human
 * line here; raw tool ids and machine refs never reach a story surface. Display-only.
 */

/** Harness plumbing, not user-meaningful work — hidden entirely. */
const HIDDEN_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'BashOutput', 'KillShell']);

/** A workspace-path target renders as its basename wherever it lands. */
function looksLikePath(t: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\') || (t.startsWith('/') && t.length > 1);
}

/** The fallback target renderer: paths basename, everything else quotes verbatim. */
function smartTarget(target: string | undefined): string {
  const t = (target ?? '').trim();
  return looksLikePath(t) ? fileName(t) : quoted(t);
}

/** The machine-ref wall: pinned refs (`ns::x@2`, `mcp__` ids) never reach a human surface raw. */
function isMachineRef(t: string): boolean {
  return t.includes('::') || t.startsWith('mcp__');
}

/** target → a short quoted name, or empty when absent/unreadable/machine. */
function quoted(target: string | undefined, max = 48): string {
  const t = (target ?? '').trim();
  if (t.length === 0 || isMachineRef(t)) return '';
  return ` '${t.length > max ? `${t.slice(0, max - 1)}…` : t}'`;
}

/** File targets show their NAME — the filename IS the news. */
function fileName(target: string | undefined): string {
  const t = (target ?? '').trim();
  if (t.length === 0) return '';
  return quoted(t.split(/[\\/]/).filter(Boolean).pop() ?? t);
}

/** URL targets show only the host. */
function host(target: string | undefined): string {
  const t = (target ?? '').trim();
  const m = /^https?:\/\/([^/]+)/.exec(t);
  return m ? ` ${m[1]}` : quoted(target);
}

/** The walled browser family; the six roster tools render from ROSTER_DEFAULTS below. */
const MCP_LABELS: Record<string, (target: string | undefined) => string> = {
  // The browser family. type_text's target is the TYPED TEXT — potentially sensitive, never rendered.
  browse_open: (t) => `Reading${host(t)}`,
  open_page: (t) => `Opening${host(t)}`,
  read_page: () => 'Reading the page',
  screenshot: () => 'Taking a look at the page',
  click: () => 'Clicking on the page',
  type_text: () => 'Typing on the page',
  scroll: () => 'Scrolling the page',
  wait: () => 'Waiting for the page',
  acquire_browser: () => 'Opening the browser',
  hand_back: () => 'Handing you the browser',
  release_browser: () => 'Done with the browser',
};

const NATIVE_LABELS: Record<string, (target: string | undefined) => string> = {
  Read: (t) => `Reading${fileName(t)}`,
  Grep: () => 'Searching files',
  Glob: () => 'Searching files',
  Write: (t) => `Writing${fileName(t)}`,
  Edit: (t) => `Writing${fileName(t)}`,
  MultiEdit: (t) => `Writing${fileName(t)}`,
  NotebookEdit: (t) => `Writing${fileName(t)}`,
  Bash: () => 'Running a command',
  PowerShell: () => 'Running a command',
  WebSearch: (t) => `Searching the web${quoted(t)}`,
  WebFetch: (t) => `Reading${host(t)}`,
  Task: () => 'Working',
  Agent: () => 'Working',
};

/** The six-tool roster (tools.ts) + browse: the call's own 2-5 word caption - the construct
 * words the receipt carries - is the feed line when it rides the target; else the plain default. */
const ROSTER_DEFAULTS: Record<string, string> = {
  read: 'Reading the project', contract: 'Checking a contract', rows: 'Reading data',
  record: 'Reading the record', pixels: 'Taking a look', edit: 'Editing the project',
  browse: 'Reading a page',
};

/** One decision for every roster tool, bare or MCP-prefixed: caption -> default. */
function rosterLabel(rosterDefault: string, target: string | undefined): string {
  const t = (target ?? '').trim();
  return t.length > 0 && !isMachineRef(t) && !looksLikePath(t)
    ? t.charAt(0).toUpperCase() + t.slice(1, 64)
    : rosterDefault;
}

/**
 * Human display line for one tool step, or null when the step should not render at all.
 * Unknown mcp tools humanize (prefix stripped, underscores → spaces); unknown native tools
 * render their bare name — never a blank, never a raw `mcp__` id.
 */
export function toolLabel(tool: string, target?: string): string | null {
  if (HIDDEN_TOOLS.has(tool)) return null;
  const rosterDefault = ROSTER_DEFAULTS[tool];
  if (rosterDefault !== undefined) return rosterLabel(rosterDefault, target);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    const base = mcp[2]!;
    const roster = ROSTER_DEFAULTS[base];
    if (roster !== undefined) return rosterLabel(roster, target);
    const known = MCP_LABELS[base];
    if (known) return known(target);
    return `${base.replace(/_/g, ' ')}${smartTarget(target)}`;
  }
  const native = NATIVE_LABELS[tool];
  if (native) return native(target);
  // Unknown tools never render a raw workspace path — basename it.
  return `${tool}${smartTarget(target)}`;
}

/** The one live-edge word for a tool step: reads → Reading, writes → Writing, else Working. */
export function toolStatusVerb(tool: string): string {
  if (HIDDEN_TOOLS.has(tool)) return 'Working';
  switch (tool) {
    case 'Read': case 'Grep': case 'Glob': case 'WebFetch': return 'Reading';
    case 'Write': case 'Edit': case 'NotebookEdit': return 'Writing';
    case 'WebSearch': return 'Searching the web';
    case 'read': case 'contract': case 'rows': case 'record': case 'pixels': case 'browse': return 'Reading';
    case 'edit': return 'Writing';
    default: return 'Working';
  }
}

