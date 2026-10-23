import { useEffect, useState } from 'react';
import { ConversationView } from '../chat/ConversationView.js';
import { Home } from '../home/Home.js';
import { CodeScreen } from '../code/CodeScreen.js';
import type { Route } from '../../lib/router.js';

// Router screens: home, thread, tabs; settings is modal overlay.
export function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'thread':
      return <ConversationView threadId={route.threadId} jobParam={route.job} />;
    case 'code':
      // R0: THE DOORLESS DOOR GETS ITS CASE — /code/:projectId finally renders (the
      // pixel law's specimen closed; the same content the slot code tabs show).
      return <CodeScreen projectId={route.projectId} initialOp={route.op} draft={route.draft} />;
  }
}

/** Below this width the sidebar auto-collapses and the toggle opens it as an OVERLAY
 * (user-directed 2026-07-20, the Cursor reference). Above it, everything docks again. */
const NARROW_QUERY = '(max-width: 719px)';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
