import { useEffect, useState } from 'react';
import { NODE_CONTRACTS } from '@nodeloom/core';
import type { NodeContract } from '@nodeloom/core';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import type { CitizenSelection } from '../../lib/canvas/store.js';
import { idTail } from '../../lib/canvas/tools/select/Idle.js';
import { channelEdgesOf, elementNoun, followsClause } from '../../lib/page-edit/flowWires.js';
import type { FlowNodeLike } from '../../lib/page-edit/flowWires.js';
import { paramWord } from '../../lib/page-edit/flowWires.js';
import { actionWriteWord, askedOnlyWhen, firesWord, whenWords } from '../../lib/canvas/store.js';
import type { ActDoc } from '../../lib/canvas/store.js';
import { openPublishTakeover } from '../../lib/publishTakeover.js';
import { NotesDetail } from '../shell/NotesDetail.js';
import styles from '../shell/sidepanel.module.css';

// A node's details inside its card, read from its node contract; the card's foot carries the verbs.

type Detail = { title: string; kind: string; lines: Array<{ indent: number; text: string; mono?: boolean }>; code: string | null };

export function NodeDetails({ selection, say }: { selection: CitizenSelection; say: (sentence: string) => void }) {
  const { orgId } = useOrg();
  const contract: NodeContract | undefined = (NODE_CONTRACTS as Record<string, NodeContract>)[selection.kind];
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sceneMeta, setSceneMeta] = useState<{ slug: string; bindings: string[] } | null>(null);
  const [sceneActs, setSceneActs] = useState<ActDoc[]>([]);
  // Follows-clauses from landed channel edges; node id -> element noun mapping.
  const [sceneFollows, setSceneFollows] = useState<Map<string, string>>(new Map());
  const [nodeNouns, setNodeNouns] = useState<Map<string, string>>(new Map());
  const [moreOpen, setMoreOpen] = useState(false);

  // Only essential and detail-tier property bodies render.
  const shows = (body: string): boolean =>
    contract?.properties.some((p) => p.body === body && (p.tier === 'essential' || p.tier === 'detail')) === true;

  useEffect(() => {
    setDetail(null);
    setSceneMeta(null);
    setSceneActs([]);
    setSceneFollows(new Map());
    setNodeNouns(new Map());
    setMoreOpen(false);
    let cancelled = false;
    if (shows('detail-lines')) {
      desk.automationNodeDetail(orgId, selection.nodeId)
        .then((d) => { if (!cancelled && d) setDetail(d); })
        .catch(() => undefined);
    }
    if (shows('scene-bindings') && selection.nodeId.startsWith('scene:')) {
      desk.sceneData(orgId, idTail(selection.nodeId))
        .then(async (s) => {
          if (cancelled) return;
          setSceneMeta({ slug: s.scene.slug, bindings: s.results.map((r) => r.binding) });
          const acts = await desk.sceneActions(orgId, s.scene.slug).catch(() => []);
          if (!cancelled) setSceneActs(acts);
          const sub = await desk.sceneSubtree(orgId, s.scene.slug, 'root', 8).catch(() => ({ subtree: null }));
          if (cancelled) return;
          const flat: FlowNodeLike[] = [];
          const walk = (n: { id: string; components: Record<string, Record<string, unknown>>; children?: unknown }): void => {
            flat.push({ id: n.id, components: n.components });
            if (Array.isArray(n.children)) for (const kid of n.children) walk(kid as typeof n);
          };
          if (sub.subtree !== null) walk(sub.subtree as never);
          setNodeNouns(new Map(flat.map((n) => [n.id, elementNoun(n)])));
          const follows = new Map<string, string>();
          for (const e of channelEdgesOf(flat)) {
            if (e.param === undefined) continue;
            const target = flat.find((n) => n.id === e.toNode);
            const source = flat.find((n) => n.id === e.fromNode);
            const action = target === undefined ? undefined
              : Object.values(target.components).map((p) => p['action']).find((v): v is string => typeof v === 'string' && v !== '');
            if (action !== undefined && source !== undefined) {
              follows.set(`${action}:${e.param}`, followsClause(elementNoun(source), e.emit));
            }
          }
          setSceneFollows(follows);
        })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, selection.nodeId, selection.kind, selection.projectId, contract]);

  if (contract === undefined) return null;

  return (
    <div className={styles.inspector}>
      {contract.properties.filter((p) => p.tier === 'essential').map((p) => renderBody(p.body))}
      {contract.properties.some((p) => p.tier === 'detail') ? (
        <section className={styles.inspectorSection}>
          <button type="button" className={styles.contractVerb} onClick={() => setMoreOpen((o) => !o)}>
            {moreOpen ? 'Less' : 'More'}
          </button>
          {moreOpen ? contract.properties.filter((p) => p.tier === 'detail').map((p) => renderBody(p.body)) : null}
        </section>
      ) : null}
    </div>
  );

  function renderBody(body: NodeContract['properties'][number]['body']): React.ReactNode {
    if (body === 'detail-lines') {
      return (
        <section key={body} className={styles.inspectorSection}>
          {(detail?.lines ?? []).slice(0, 40).map((l, i) => (
            <div key={i} className={styles.contractLine} style={{ paddingLeft: 8 + Math.min(l.indent, 3) * 12 }}>
              <span className={l.mono === true ? styles.contractMono : styles.contractText}>{l.text}</span>
            </div>
          ))}
        </section>
      );
    }
    if (body === 'scene-bindings') {
      const bound = sceneMeta?.bindings.length ?? 0;
      return (
        <section key={body} className={styles.inspectorSection}>
          {bound > 0 ? (
            <div className={styles.contractText}>{`shows ${bound} ${bound === 1 ? 'table' : 'tables'}`}</div>
          ) : null}
          {sceneActs.length > 0 ? (
            <>
              <div className={styles.inspectorRef}>can do</div>
              {sceneActs.map((a) => (
                <div key={a.name}>
                  <div className={styles.inspectorRowStatic}>
                    <span className={styles.contractText}>
                      {a.title} — {a.writes.map((w) => actionWriteWord(w)).join(', ') || 'does nothing yet'}
                    </span>
                    <button
                      type="button" className={styles.stripBtn} aria-label={`Remove '${a.title}'`} title="Remove"
                      onClick={() => {
                        const slug = sceneMeta?.slug;
                        if (slug === undefined) return;
                        void desk.humanRemoveAction(orgId, slug, a.name).then((r) => {
                          if (!r.ok) say(r.error);
                          else setSceneActs((prev) => prev.filter((x) => x.name !== a.name));
                        });
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {a.fires !== undefined ? (
                    <div className={styles.contractSub}>└ {firesWord(a.fires, (n) => nodeNouns.get(n) ?? 'an input')}</div>
                  ) : null}
                  {a.writes.filter((w) => w.when !== undefined).map((w, i) => (
                    <div key={`w${i}`} className={styles.contractSub}>└ only when {whenWords(w.when!, a.params)}</div>
                  ))}
                  {a.params.map((p) => {
                    const gated = askedOnlyWhen(a, p.name);
                    const follows = sceneFollows.get(`${a.name}:${p.name}`);
                    if (gated === null && follows === undefined) return null;
                    return (
                      <div key={p.name} className={styles.contractSub}>
                        {paramWord(p.name)}
                        {follows !== undefined ? ` — ${follows}` : ''}
                        {gated !== null ? ` — asked only when ${whenWords(gated, a.params)}` : ''}
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          ) : null}
        </section>
      );
    }
    // Publishing: open the full-screen project settings surface.
    if (body === 'publishing') {
      const projectId = selection.projectId ?? (selection.nodeId.startsWith('project:') ? idTail(selection.nodeId) : null);
      return projectId !== null ? (
        <section key={body} className={styles.inspectorSection}>
          <div className={styles.inspectorRef}>publishing</div>
          <button type="button" className={styles.contractVerb} onClick={() => openPublishTakeover({ projectId, section: 'publish' })}>
            Open project settings
          </button>
        </section>
      ) : null;
    }
    return selection.projectId !== null ? (
      <section key={body} className={styles.inspectorSection}>
        <NotesDetail projectId={selection.projectId} />
      </section>
    ) : null;
  }
}
