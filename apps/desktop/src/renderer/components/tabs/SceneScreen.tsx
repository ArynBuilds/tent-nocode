import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive, useLivePush } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { useSceneNav } from './sceneNav.js';
import styles from './tabs.module.css';

// THE RUNNING APP (Phase 12, row 12.16): the served page in its sandboxed iframe over one MessagePort - the
// feed once, then the live pushes ({binding, rows} deltas folded into the held feed and posted; a settled
// run's effects), an action's answer with its effects back on the same port, the projections on request,
// and a goto as a nav. No editor lane lives here: editing mounts the engine directly (FrameFace).

const READY_TIMEOUT_MS = 5_000;
const REFETCH_DEBOUNCE_MS = 500;

export function SceneScreen({ sceneId }: { sceneId: string }) {
  const { orgId } = useOrg();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const readyRef = useRef(false);
  const [stalled, setStalled] = useState(false);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const retryRef = useRef(0);
  const warmupTimer = useRef<number | undefined>(undefined);
  const { mountedId, mountedKey, mountedIdRef, mountedKeyRef, navToSlug } = useSceneNav(sceneId, orgId);

  const { data, refetch, patch } = useQuery(`sceneData:${mountedId}:${mountedKey ?? ''}:${frameEpoch}`, () => desk.sceneData(orgId, mountedId, mountedKey), [orgId, mountedId, mountedKey]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const post = useCallback((msg: Record<string, unknown>): void => {
    const port = portRef.current;
    if (port !== null && readyRef.current) port.postMessage(msg);
  }, []);

  // The document changed under the mount: one debounced refetch per burst of pointers.
  const debounceRef = useRef<number | undefined>(undefined);
  useLive(['scenes', 'scene_revisions'], () => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(refetch, REFETCH_DEBOUNCE_MS);
  });
  // The push: a binding's rows land in the held feed and on the port; a keyed mount re-reads its one-row feed.
  useLivePush((m) => {
    if (m.kind === 'binding') {
      if (m.sceneId !== mountedIdRef.current) return;
      if (mountedKeyRef.current !== undefined) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(refetch, REFETCH_DEBOUNCE_MS);
        return;
      }
      patch((d) => ({ ...d, results: d.results.map((r) => (r.binding === m.binding ? { ...r, rows: m.rows, text: m.text, error: m.error, ...(m.tick !== undefined ? { tick: m.tick } : {}) } : r)) }));
      if (m.error !== null) post({ type: 'error', binding: m.binding, message: m.error });
      else post({ type: 'data', binding: m.binding, rows: m.rows, text: m.text, ...(m.tick !== undefined ? { tick: m.tick } : {}) });
      return;
    }
    if (m.kind === 'effects' && m.scene === dataRef.current?.scene.slug) {
      post({ type: 'effects', effects: m.effects, status: m.status, ...(m.error !== undefined ? { error: m.error } : {}) });
    }
  });

  // Projections: one in flight per binding, the latest request wins.
  const projInFlightRef = useRef(new Set<string>());
  const projLatestRef = useRef(new Map<string, { key: string; request: unknown }>());
  const pumpProjection = useCallback((binding: string): void => {
    const next = projLatestRef.current.get(binding);
    if (next === undefined) { projInFlightRef.current.delete(binding); return; }
    projLatestRef.current.delete(binding);
    projInFlightRef.current.add(binding);
    void desk.sceneProjection(orgId, mountedIdRef.current, binding, next.request).then((r) => {
      post({ type: 'projection', binding, key: next.key, dtype: r.dtype, shape: r.shape, data: r.data, error: r.error });
    }).catch(() => undefined).finally(() => pumpProjection(binding));
  }, [orgId, post, mountedIdRef]);

  const feed = useCallback((): void => {
    const d = dataRef.current;
    if (!portRef.current || !readyRef.current || !d) return;
    post({ type: 'scene', document: d.document, ...(d.targetScreen !== null ? { targetScreen: d.targetScreen } : {}) });
    for (const r of d.results) {
      if (r.error !== null) post({ type: 'error', binding: r.binding, message: r.error });
      else post({ type: 'data', binding: r.binding, rows: r.rows, text: r.text, ...(r.tick !== undefined ? { tick: r.tick } : {}) });
    }
  }, [post]);

  useEffect(() => { feed(); }, [data, feed]);

  const onFrameLoad = useCallback((): void => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    const channel = new MessageChannel();
    portRef.current = channel.port1;
    readyRef.current = false;
    setStalled(false);
    channel.port1.onmessage = ({ data: raw }: MessageEvent<unknown>) => {
      const msg = raw as { type?: unknown; name?: unknown; values?: unknown };
      if (msg?.type === 'ready') { readyRef.current = true; feed(); return; }
      if (msg?.type === 'refresh') { refetch(); return; }
      if (msg?.type === 'project' && typeof (msg as { binding?: unknown }).binding === 'string') {
        const m = msg as { binding: string; slice?: unknown; downsample?: unknown; key?: unknown };
        projLatestRef.current.set(m.binding, { key: typeof m.key === 'string' ? m.key : '', request: { slice: m.slice ?? [], downsample: m.downsample ?? 1 } });
        if (!projInFlightRef.current.has(m.binding)) pumpProjection(m.binding);
        return;
      }
      if (msg?.type === 'nav' && typeof (msg as { scene?: unknown }).scene === 'string') {
        const rawKey = (msg as { key?: unknown }).key;
        navToSlug(dataRef.current?.scene.title ?? '', (msg as { scene: string }).scene, typeof rawKey === 'string' ? rawKey : undefined);
        return;
      }
      if (msg?.type === 'action' && typeof msg.name === 'string') {
        const name = msg.name;
        const values = (typeof msg.values === 'object' && msg.values !== null ? msg.values : {}) as Record<string, unknown>;
        void desk.sceneAction(orgId, dataRef.current?.scene.slug ?? '', name, values).then((res) => {
          if (res.ok && res.data) {
            const a = res.data;
            post({ type: 'action:result', name, ok: a.ok, failures: a.ok ? [] : a.failures, results: a.ok ? a.results : [], effects: a.ok ? a.effects : [] });
          }
          else post({ type: 'action:result', name, ok: false, failures: [res.ok ? 'the action returned nothing' : res.error] });
        });
      }
    };
    frame.contentWindow.postMessage({ type: 'init' }, '*', [channel.port2]);
    window.setTimeout(() => {
      if (readyRef.current) { retryRef.current = 0; return; }
      setStalled(true);
      const backoff = Math.min(30_000, 2_000 * 2 ** retryRef.current);
      retryRef.current += 1;
      window.clearTimeout(warmupTimer.current);
      warmupTimer.current = window.setTimeout(() => { setStalled(false); setFrameEpoch((e) => e + 1); }, backoff);
    }, READY_TIMEOUT_MS);
  }, [feed, refetch, orgId, pumpProjection, navToSlug, post]);

  useEffect(() => () => {
    portRef.current?.close();
    window.clearTimeout(debounceRef.current);
    window.clearTimeout(warmupTimer.current);
  }, []);

  return (
    <div className={styles.screen}>
      {stalled ? (
        <div className={styles.warmup}>
          <p>warming up...</p>
          <button type="button" className={styles.warmupNow} onClick={() => { window.clearTimeout(warmupTimer.current); setStalled(false); setFrameEpoch((e) => e + 1); }}>try now</button>
        </div>
      ) : (
        <iframe
          key={`${mountedId}:${mountedKey ?? ''}:${frameEpoch}`} ref={iframeRef} className={styles.frame} sandbox="allow-scripts"
          src={`tab://local/scene/${mountedId}`} title="scene" onLoad={onFrameLoad}
        />
      )}
    </div>
  );
}
