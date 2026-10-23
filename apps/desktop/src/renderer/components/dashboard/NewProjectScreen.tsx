import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AppWindow, ArrowLeft, ArrowRight, Globe } from 'lucide-react';
import { Ambient } from '../brand/Ambient.js';
import { Takeover } from '../kit/SettingsPage.js';
import { kit } from '../kit/kit.js';
import styles from './newProject.module.css';

// The new-project moment: the name typed straight into a big title, the kind picked from two living previews,
// one verb to begin. Enter creates; Esc or Back returns to the apps page.

type Kind = 'app' | 'website';

const KINDS: Array<{ id: Kind; label: string; line: string; icon: typeof AppWindow }> = [
  { id: 'app', label: 'App', line: 'A focused tool: trackers, dashboards, forms.', icon: AppWindow },
  { id: 'website', label: 'Website', line: 'Pages with navigation that can hold your apps.', icon: Globe },
];

/** A tiny app: a side list and cards that fill in. */
function AppPreview() {
  return (
    <div className={styles.mock}>
      <div className={styles.mockSide}>
        <span className={styles.mockDot} />
        <span className={styles.mockLine} style={{ width: '70%' }} />
        <span className={styles.mockLine} style={{ width: '55%' }} />
        <span className={styles.mockLine} style={{ width: '62%' }} />
      </div>
      <div className={styles.mockMain}>
        <div className={styles.mockStats}>
          <span className={styles.mockStat} />
          <span className={styles.mockStat} />
          <span className={styles.mockStat} />
        </div>
        <div className={styles.mockChart}>
          {[38, 62, 48, 80, 56, 92, 70].map((h, i) => (
            <span key={i} className={styles.mockBar} style={{ height: `${h}%`, animationDelay: `${i * 60}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A tiny website: a nav bar, a headline and sections. */
function WebsitePreview() {
  return (
    <div className={`${styles.mock} ${styles.mockSite}`}>
      <div className={styles.mockNav}>
        <span className={styles.mockDot} />
        <span className={styles.mockNavLinks}>
          <span className={styles.mockLine} style={{ width: 18 }} />
          <span className={styles.mockLine} style={{ width: 22 }} />
          <span className={styles.mockLine} style={{ width: 16 }} />
        </span>
      </div>
      <div className={styles.mockHero}>
        <span className={styles.mockHeadline} />
        <span className={styles.mockLine} style={{ width: '46%' }} />
        <span className={styles.mockPill} />
      </div>
      <div className={styles.mockSections}>
        <span className={styles.mockSection} />
        <span className={styles.mockSection} />
        <span className={styles.mockSection} />
      </div>
    </div>
  );
}

export function NewProjectScreen({ onCreate, onCancel }: {
  onCreate: (kind: Kind, name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('app');
  const [creating, setCreating] = useState(false);
  const tileRefs = useRef(new Map<Kind, HTMLButtonElement>());

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key !== 'Escape' || creating) return;
      e.preventDefault();
      onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, creating]);

  const create = (e?: FormEvent): void => {
    e?.preventDefault();
    if (creating) return;
    setCreating(true);
    onCreate(kind, name.trim());
  };

  // The two tiles are one radio group: arrows move the choice like a native radio group; Enter creates.
  const onTilesKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); create(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: Kind = kind === 'app' ? 'website' : 'app';
    setKind(next);
    tileRefs.current.get(next)?.focus();
  };

  const word = kind === 'app' ? 'app' : 'website';
  return (
    <Takeover>
      <div className={styles.stage}>
        <Ambient />
        <button type="button" className={styles.back} onClick={onCancel}>
          <ArrowLeft size={15} />
          <span>Back</span>
        </button>
        <form className={styles.column} onSubmit={create}>
          <div className={styles.eyebrow}>New project</div>
          <input
            className={styles.title}
            value={name}
            maxLength={120}
            autoFocus
            spellCheck={false}
            aria-label="Project name"
            placeholder={`Untitled ${word}`}
            onChange={(e) => setName(e.target.value)}
          />
          <p className={styles.lead}>Give it a name, pick what it is, and you will land on its empty canvas. You can rename it later; the kind stays.</p>

          <div className={styles.tiles} role="radiogroup" aria-label="What are you building?" onKeyDown={onTilesKey}>
            {KINDS.map(({ id, label, line, icon: Icon }) => {
              const on = kind === id;
              return (
                <button
                  key={id}
                  ref={(el) => { if (el !== null) tileRefs.current.set(id, el); else tileRefs.current.delete(id); }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  className={on ? `${styles.tile} ${styles.tileOn}` : styles.tile}
                  onClick={() => setKind(id)}
                  onDoubleClick={() => { setKind(id); create(); }}
                >
                  <div className={styles.preview}>{id === 'app' ? <AppPreview /> : <WebsitePreview />}</div>
                  <div className={styles.tileText}>
                    <span className={styles.tileName}><Icon size={16} />{label}</span>
                    <span className={styles.tileLine}>{line}</span>
                  </div>
                  <span className={styles.check} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          <div className={styles.foot}>
            <span className={styles.keys}><kbd>Enter</kbd> to create <span className={styles.sep} /> <kbd>Esc</kbd> to go back</span>
            <button type="submit" className={`${kit.btn} ${kit.btnPrimary} ${styles.go}`} disabled={creating}>
              {creating ? 'Creating…' : `Create ${word}`}
              {creating ? null : <ArrowRight size={16} />}
            </button>
          </div>
        </form>
      </div>
    </Takeover>
  );
}
