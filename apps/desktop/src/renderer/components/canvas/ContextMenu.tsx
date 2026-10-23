import { useEffect, useState } from 'react';
import { filterMenuRows, MENU_SEARCH_FLOOR } from '../../lib/canvas/store.js';
import type { MenuGroups } from '../../lib/canvas/store.js';
import styles from './contextmenu.module.css';

/** The one right-click menu: every right-click grammar in the app renders through it. */

export function ContextMenu({ at, groups, search = 'auto', placeholder = 'search…', onClose }: {
  /** Client px — the pointer; clamped so the menu never leaves the viewport. */
  at: { x: number; y: number };
  groups: MenuGroups;
  /** 'always' = the create palette (search bar on top); 'auto' = past the floor. */
  search?: 'always' | 'auto';
  placeholder?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  // Esc closes on capture so floating chrome consumes the press before the window listeners.
  // Light-dismiss on pointerdown, never click: a menu born at a drag's release (the create ask)
  // would be eaten by that drag's own trailing click - the next PRESS outside is the dismissal.
  useEffect(() => {
    const close = (): void => onClose();
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const rowCount = groups.reduce((n, g) => n + g.length, 0);
  const showSearch = search === 'always' || rowCount > MENU_SEARCH_FLOOR;
  const shown = filterMenuRows(groups, showSearch ? query : '');
  const first = shown[0]?.[0];

  const act = (fn: () => void): void => { onClose(); fn(); };

  return (
    <div
      className={styles.menu}
      style={{ left: Math.max(8, Math.min(at.x, window.innerWidth - 264)), top: Math.max(8, Math.min(at.y, window.innerHeight - 408)) }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {showSearch ? (
        <input
          className={styles.search}
          autoFocus
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first !== undefined) act(first.onAct);
          }}
        />
      ) : null}
      <div className={styles.rows}>
        {shown.map((group, gi) => (
          <div key={gi}>
            {gi > 0 ? <div className={styles.divider} /> : null}
            {group.map((r) => (
              <button key={r.key} type="button" className={styles.row} onClick={() => act(r.onAct)}>
                {r.icon !== undefined ? <r.icon size={14} className={styles.icon} /> : <span className={styles.icon} />}
                <span className={styles.label}>{r.label}</span>
                {r.shortcut !== undefined ? <span className={styles.shortcut}>{r.shortcut}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
