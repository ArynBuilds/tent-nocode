import { useEffect, useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { kit } from './kit.js';
import styles from './settingsPage.module.css';

// The full-screen settings page: Back, who it belongs to, a section list on the left, one readable column on the right.

export interface PageSection<Id extends string> {
  id: Id;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

/** Esc closes the page alone (capture + stop); a control that holds its own Esc keeps it. */
export function useTakeoverEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (e.target instanceof Element && e.target.closest('[data-own-escape]') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, close]);
}

/** The page's frame over everything under the titlebar; the screens underneath stay mounted. */
export function Takeover({ children }: { children: ReactNode }) {
  return <div className={`${styles.takeover} ${kit.readable}`} data-scroll-root="">{children}</div>;
}

export function SettingsPage<Id extends string>({ title, subtitle, label, sections, active, onPick, onBack, children }: {
  title?: string;
  subtitle?: string;
  /** The section list's accessible name. */
  label: string;
  sections: Array<PageSection<Id>>;
  active: Id | null;
  onPick: (id: Id) => void;
  onBack: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<Id, HTMLButtonElement>());

  useEffect(() => {
    rootRef.current?.closest('[data-scroll-root]')?.scrollTo({ top: 0 });
  }, [active]);

  // The section list is a vertical tab list: arrows move, Home and End jump.
  const onNavKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = sections.findIndex((s) => s.id === active);
    const to = e.key === 'ArrowDown' ? sections[(i + 1) % sections.length]
      : e.key === 'ArrowUp' ? sections[(i - 1 + sections.length) % sections.length]
        : e.key === 'Home' ? sections[0]
          : e.key === 'End' ? sections[sections.length - 1]
            : undefined;
    if (to === undefined) return;
    e.preventDefault();
    onPick(to.id);
    tabRefs.current.get(to.id)?.focus();
  };

  return (
    <div ref={rootRef} className={styles.layout}>
      <aside className={styles.side}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={14} />
          <span>Back</span>
        </button>
        {title !== undefined ? (
          <div className={styles.identity}>
            <div className={styles.name} title={title}>{title}</div>
            {subtitle !== undefined ? <div className={styles.subtitle}>{subtitle}</div> : null}
          </div>
        ) : null}
        {sections.length > 0 ? (
          <div className={styles.nav} role="tablist" aria-orientation="vertical" aria-label={label} onKeyDown={onNavKey}>
            {sections.map(({ id, label: text, icon: Icon }) => {
              const on = id === active;
              return (
                <button
                  key={id}
                  ref={(el) => { if (el !== null) tabRefs.current.set(id, el); else tabRefs.current.delete(id); }}
                  type="button"
                  role="tab"
                  id={`page-tab-${id}`}
                  aria-selected={on}
                  aria-controls="page-pane"
                  tabIndex={on ? 0 : -1}
                  className={on ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
                  onClick={() => onPick(id)}
                >
                  <Icon size={15} />
                  <span>{text}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </aside>
      <main className={styles.content}>
        {active !== null ? (
          <div key={active} id="page-pane" role="tabpanel" aria-labelledby={`page-tab-${active}`} className={styles.pane}>
            {children}
          </div>
        ) : children}
      </main>
    </div>
  );
}
