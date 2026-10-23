import { useCallback, useEffect, useRef, useState } from 'react';
import { desk } from '../../lib/desk.js';

// The screen navigation stack over the action's answer: a goto effect (or the engine's own nav) walks to a
// screen by slug, with an optional row key for a filtered detail view; ':back' returns the prior screen
// with its key. The stack is the host's; the engine only names where.

export interface SceneNavEntry { id: string; title: string; key?: string }

export function useSceneNav(sceneId: string, orgId: string): {
  mountedId: string;
  mountedKey: string | undefined;
  mountedIdRef: React.MutableRefObject<string>;
  mountedKeyRef: React.MutableRefObject<string | undefined>;
  navStackRef: React.MutableRefObject<SceneNavEntry[]>;
  navPush: (currentTitle: string, next: { id: string; key?: string }) => void;
  navBack: () => void;
  /** Walks to a screen by slug (a goto effect, a nav message); ':back' pops; an unknown slug is a no-op. */
  navToSlug: (currentTitle: string, slug: string, key?: string) => void;
} {
  const [mountedId, setMountedId] = useState(sceneId);
  const mountedIdRef = useRef(mountedId);
  mountedIdRef.current = mountedId;
  const [mountedKey, setMountedKey] = useState<string | undefined>(undefined);
  const mountedKeyRef = useRef(mountedKey);
  mountedKeyRef.current = mountedKey;
  const navStackRef = useRef<SceneNavEntry[]>([]);
  useEffect(() => {
    setMountedId(sceneId);
    setMountedKey(undefined);
    navStackRef.current = [];
  }, [sceneId]);

  /** Walk forward: the departing screen (id + its key) joins the stack. */
  const navPush = useCallback((currentTitle: string, next: { id: string; key?: string }): void => {
    navStackRef.current.push({
      id: mountedIdRef.current, title: currentTitle,
      ...(mountedKeyRef.current !== undefined ? { key: mountedKeyRef.current } : {}),
    });
    setMountedId(next.id);
    setMountedKey(next.key);
  }, []);

  /** ':back' - the prior screen returns WITH its row key (or its honest absence). */
  const navBack = useCallback((): void => {
    const prev = navStackRef.current.pop();
    if (prev) {
      setMountedId(prev.id);
      setMountedKey(prev.key);
    }
  }, []);

  const navToSlug = useCallback((currentTitle: string, slug: string, key?: string): void => {
    if (slug === ':back') { navBack(); return; }
    void desk.sceneBySlug(orgId, slug).then((hit) => {
      if (hit) navPush(currentTitle, { id: hit.id, ...(key !== undefined && key !== '' ? { key } : {}) });
    });
  }, [orgId, navPush, navBack]);

  return { mountedId, mountedKey, mountedIdRef, mountedKeyRef, navStackRef, navPush, navBack, navToSlug };
}
