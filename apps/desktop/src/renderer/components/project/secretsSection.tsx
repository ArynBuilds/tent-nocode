import { useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { desk } from '../../lib/desk.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { ConfirmAction, Empty, Group, IDLE, Item, Row, SectionHead, StatusLine, errorText, kit, type RowState } from './kit.js';
import type { ProjectNavItem } from './projectNav.js';
import styles from './project.module.css';

// Project secrets: names listed, values written blind; a project secret wins over an account secret of the same name.

export function SecretsSection({ item, orgId, projectId }: { item: ProjectNavItem; orgId: string; projectId: string }) {
  const names = useQuery(`project-secrets:${projectId}`, () => desk.listSecretNames(orgId, projectId), [orgId, projectId]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [state, setState] = useState<RowState>(IDLE);
  const [listState, setListState] = useState<RowState>(IDLE);
  const valueRef = useRef<HTMLInputElement | null>(null);
  const list = names.data ?? [];
  const trimmed = name.trim();
  const replacing = list.includes(trimmed);

  const save = (): void => {
    if (trimmed === '' || value === '') return;
    setState({ phase: 'working', sentence: 'Saving…' });
    void desk.setSecret(orgId, trimmed, value, projectId).then((res) => {
      if (!res.ok) { setState({ phase: 'failed', sentence: 'Could not save the secret.', detail: res.error }); return; }
      setState({ phase: 'done', sentence: replacing ? `Replaced ${trimmed}.` : `Saved ${trimmed}.` });
      setName('');
      setValue('');
      setReveal(false);
      names.refetch();
    }).catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not save the secret.', detail: errorText(err) }));
  };

  const remove = async (n: string): Promise<void> => {
    setListState(IDLE);
    try {
      const res = await desk.deleteSecret(orgId, n, projectId);
      if (!res.ok) setListState({ phase: 'failed', sentence: `Could not delete ${n}.`, detail: res.error });
      names.refetch();
    } catch (err) {
      setListState({ phase: 'failed', sentence: `Could not delete ${n}.`, detail: errorText(err) });
    }
  };

  const startReplace = (n: string): void => {
    setName(n);
    setValue('');
    setState(IDLE);
    valueRef.current?.focus();
  };

  return (
    <>
      <SectionHead title={item.label} description={item.description} />
      <Group title={replacing ? 'Replace a secret' : 'Add a secret'}>
        <form className={styles.secretForm} onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Row label="Name" htmlFor="secret-name" stack hint="The name your tools ask for, for example STRIPE_KEY.">
            <input
              id="secret-name"
              className={`${kit.input} ${kit.mono}`}
              value={name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => { setName(e.target.value); setState(IDLE); }}
            />
          </Row>
          <Row label="Value" htmlFor="secret-value" stack hint={replacing ? 'Saving replaces the current value.' : 'You will not be able to see it again after saving.'}>
            <input
              id="secret-value"
              ref={valueRef}
              className={`${kit.input} ${kit.mono}`}
              type={reveal ? 'text' : 'password'}
              value={value}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type="button"
              className={`${kit.btn} ${kit.btnQuiet}`}
              aria-label={reveal ? 'Hide value' : 'Show value'}
              aria-pressed={reveal}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </Row>
          <div className={styles.formFoot}>
            <StatusLine state={state} />
            <button type="submit" className={`${kit.btn} ${kit.btnPrimary}`} disabled={trimmed === '' || value === '' || state.phase === 'working'}>
              {replacing ? 'Replace secret' : 'Save secret'}
            </button>
          </div>
        </form>
      </Group>
      <Group title="Saved for this project">
        {names.error !== undefined ? <StatusLine state={{ phase: 'failed', sentence: 'Could not read the saved secrets.', detail: names.error }} /> : null}
        {names.data === undefined && names.error === undefined ? <Empty>Loading…</Empty> : null}
        {names.data !== undefined && list.length === 0 ? (
          <Empty>No project secrets yet. Until you add one, this project uses the secrets saved in the app settings.</Empty>
        ) : null}
        {list.map((n) => (
          <Item key={n} name={n} note="Value hidden">
            <button type="button" className={`${kit.btn} ${kit.btnQuiet}`} onClick={() => startReplace(n)}>Replace</button>
            <ConfirmAction label="Delete" prompt={`Delete ${n}?`} confirmLabel="Delete" workingLabel="Deleting…" onConfirm={() => remove(n)} />
          </Item>
        ))}
        <StatusLine state={listState} />
      </Group>
    </>
  );
}
