import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'thread'; threadId: string; job?: string; query: Record<string, string> }
  | { name: 'code'; projectId?: string; op?: string; draft?: boolean };

/** Parses a `?a=1&b=2` query string (no leading `?`) into a plain param map. Empty string -> `{}`. */
function parseQuery(queryString: string): Record<string, string> {
  const query: Record<string, string> = {};
  if (queryString === '') return query;
  for (const pair of queryString.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    if (!rawKey) continue;
    query[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
  }
  return query;
}

export function parsePath(path: string): Route {
  const [rawPath = '/', rawQuery = ''] = path.split('?', 2);
  const query = parseQuery(rawQuery);
  const job = query['job'];

  const threadMatch = /^\/thread\/(.+)$/.exec(rawPath);
  if (threadMatch?.[1]) {
    return { name: 'thread', threadId: decodeURIComponent(threadMatch[1]), job, query };
  }
  const codeMatch = /^\/code(?:\/(.+))?$/.exec(rawPath);
  if (codeMatch) {
    return {
      name: 'code',
      ...(codeMatch[1] !== undefined && codeMatch[1] !== '' ? { projectId: decodeURIComponent(codeMatch[1]) } : {}),
      ...(query['op'] !== undefined ? { op: query['op'] } : {}),
      ...(query['draft'] === '1' ? { draft: true } : {}),
    };
  }
  return { name: 'home' };
}

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash === '' ? '/' : hash;
}

/** Pushes a new route. `path` is a plain route path (e.g. `/agents`, `/thread/abc`) — no leading `#`. */
export function navigate(path: string): void {
  window.location.hash = path;
}

/** Re-renders the calling component whenever the hash-route changes. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(currentPath()));

  useEffect(() => {
    const onHashChange = (): void => setRoute(parsePath(currentPath()));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}
