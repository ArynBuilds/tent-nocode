import { useCallback, useEffect, useRef, useState } from 'react';

// Fetch-on-mount plus manual refetch over one desk read, and `patch` so a live push lands in the held
// result without a round trip (the push carries the rows; the pointer alone still refetches). No cache:
// the hook holds the single most recent result.

export interface UseQueryResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
  /** Folds a push into the held data in place; a screen applies {binding, rows} here. */
  patch: (fn: (current: T) => T) => void;
}

/** `key` identifies the query - like `deps`, changing it re-runs `fetcher`. */
export function useQuery<T>(key: string, fetcher: () => Promise<T>, deps: unknown[]): UseQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // The latest fetcher runs without joining the effect's dependency array (fetchers are inline closures).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const patch = useCallback((fn: (current: T) => T) => {
    setData((cur) => (cur === undefined ? cur : fn(cur)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
    // `key`/`tick` are the intended re-run triggers; `deps` lets callers add their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, ...deps]);

  return { data, loading, error, refetch, patch };
}
