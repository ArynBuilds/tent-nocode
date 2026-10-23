import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { elementNoun } from '../../lib/page-edit/flowWires.js';
import styles from './sidepanel.module.css';

// The "Fires when" row: edits an action's changed-trigger via a dropdown of the scene's inputs.

interface ParamNode { id: string; noun: string }

/** The scene's input elements - nodes whose stored payloads collect a param. */
function paramNodesOf(subtree: unknown): ParamNode[] {
  const out: ParamNode[] = [];
  const walk = (n: { id: string; components: Record<string, Record<string, unknown>>; children?: unknown }): void => {
    const collects = Object.values(n.components).some((p) => typeof p['param'] === 'string' && p['param'] !== '');
    if (collects) out.push({ id: n.id, noun: elementNoun(n) });
    if (Array.isArray(n.children)) for (const kid of n.children) walk(kid as typeof n);
  };
  if (subtree !== null && typeof subtree === 'object') walk(subtree as never);
  return out;
}

export function FiresRow({ sceneSlug, action, onNotice }: {
  sceneSlug: string;
  action: string;
  onNotice: (sentence: string | null) => void;
}) {
  const { orgId } = useOrg();
  const actsQ = useQuery(
    `firesActs:${sceneSlug}`,
    () => desk.sceneActions(orgId, sceneSlug).catch(() => []),
    [orgId, sceneSlug],
  );
  useLive(['scenes'], actsQ.refetch);
  const subQ = useQuery(
    `firesNodes:${sceneSlug}`,
    () => desk.sceneSubtree(orgId, sceneSlug, 'root', 8).catch(() => ({ revision: 0, subtree: null, truncated: false })),
    [orgId, sceneSlug],
  );

  const doc = (actsQ.data ?? []).find((a) => a.name === action);
  // Undeclared actions have no trigger to edit.
  if (doc === undefined) return null;
  const nodes = paramNodesOf(subQ.data?.subtree ?? null);
  const current = doc.fires === undefined ? '' : doc.fires.node ?? 'any';

  const put = (picked: string): void => {
    const fires = picked === '' ? null
      : picked === 'any' ? { on: 'changed' as const }
        : { on: 'changed' as const, node: picked };
    void desk.humanSetAction(orgId, sceneSlug, { name: action, fires }).then((r) => {
      if (!r.ok) onNotice(r.error);
      else {
        onNotice(null);
        actsQ.refetch();
      }
    });
  };

  return (
    <div className={styles.inspectorRowStatic}>
      <span className={styles.inspectorKey}>Fires when</span>
      <select
        className={styles.inspectorSelect}
        value={current}
        onChange={(e) => put(e.target.value)}
      >
        <option value="">only when clicked</option>
        <option value="any">any input changes</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>{`${n.noun} changes`}</option>
        ))}
        {current !== '' && current !== 'any' && !nodes.some((n) => n.id === current) ? (
          <option value={current}>a gone element changes</option>
        ) : null}
      </select>
    </div>
  );
}
