import { useState } from 'react';
import { ArrowLeft, CalendarClock, Monitor, Table2, Wrench } from 'lucide-react';
import { NAMED_INSERTS, kebabName, type AddKind } from '../../lib/canvas/store.js';
import { Logo } from '../brand/Logo.js';
import styles from './emptyCanvas.module.css';

// The first look at an empty project: the four things to start with, one click each, and where the rest lives.
// A piece that needs a name asks for it right here in the card.

const STARTS: Array<{ kind: AddKind; label: string; line: string; icon: typeof Table2 }> = [
  { kind: 'table', label: 'Table', line: 'Rows your app keeps', icon: Table2 },
  { kind: 'view', label: 'Screen', line: 'What people see', icon: Monitor },
  { kind: 'watcher', label: 'Trigger', line: 'Run on a schedule or event', icon: CalendarClock },
  { kind: 'tool', label: 'Tool', line: 'A small program', icon: Wrench },
];

export function EmptyCanvas({ website, onAdd, onNamed }: {
  website: boolean;
  onAdd: (kind: AddKind) => void;
  onNamed: (kind: AddKind, name: string, typed: string) => void;
}) {
  const [naming, setNaming] = useState<(typeof STARTS)[number] | null>(null);
  const [typed, setTyped] = useState('');
  const finalName = naming?.kind === 'table' ? kebabName(typed) : typed.trim();
  const pick = (s: (typeof STARTS)[number]): void => {
    if (NAMED_INSERTS.has(s.kind)) { setNaming(s); setTyped(''); } else onAdd(s.kind);
  };
  const create = (): void => {
    if (naming === null || finalName === '') return;
    onNamed(naming.kind, finalName, typed.trim());
  };
  const what = naming === null ? '' : naming.kind === 'view' ? (website ? 'page' : 'screen') : naming.label.toLowerCase();
  return (
    <div className={styles.wrap}>
      <div className={styles.card} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <Logo size={30} className={styles.mark} />
        {naming === null ? (
          <>
            <div className={styles.title}>Start your {website ? 'website' : 'app'}</div>
            <div className={styles.line}>Place the first piece, or describe what you want in the chat below.</div>
            <div className={styles.starts}>
              {STARTS.map((s, i) => {
                const Icon = s.icon;
                return (
                  <button key={s.kind} type="button" className={styles.start} style={{ animationDelay: `${120 + i * 50}ms` }} onClick={() => pick(s)}>
                    <span className={styles.icon}><Icon size={16} /></span>
                    <span className={styles.label}>{s.label}</span>
                    <span className={styles.sub}>{s.line}</span>
                  </button>
                );
              })}
            </div>
            <div className={styles.foot}>Right-click anywhere on the canvas for everything else.</div>
          </>
        ) : (
          <form className={styles.naming} onSubmit={(e) => { e.preventDefault(); create(); }}>
            <div className={styles.title}>Name your {what}</div>
            <div className={styles.line}>{naming.kind === 'table' ? 'For example: Habits, or Monthly costs.' : naming.kind === 'view' ? 'For example: Today, or Overview.' : 'Lowercase words joined by dashes, for example sum-expenses.'}</div>
            <input
              className={styles.input}
              autoFocus
              spellCheck={false}
              aria-label={`Name your ${what}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }}
            />
            <div className={styles.namingFoot}>
              <button type="button" className={styles.back} onClick={() => setNaming(null)}>
                <ArrowLeft size={14} />
                Back
              </button>
              <button type="submit" className={styles.create} disabled={finalName === ''}>Create {what}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
