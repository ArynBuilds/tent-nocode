import { useEffect, useState } from 'react';

const KEY = 'tent-nocode-theme';
type Theme = 'dark' | 'light';

const HAS_DOM = typeof localStorage !== 'undefined' && typeof document !== 'undefined';

let current: Theme = (HAS_DOM && localStorage.getItem(KEY) === 'light' ? 'light' : 'dark');
const listeners = new Set<(t: Theme) => void>();

function apply(t: Theme): void {
  if (!HAS_DOM) return;
  if (t === 'light') document.documentElement.dataset['theme'] = 'light';
  else delete document.documentElement.dataset['theme'];
}

apply(current);

export function getTheme(): Theme {
  return current;
}

export function setTheme(t: Theme): void {
  current = t;
  try { localStorage.setItem(KEY, t); } catch { /* view-state only */ }
  apply(t);
  for (const l of listeners) l(t);
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

/** React hook: current theme, live. */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(current);
  useEffect(() => {
    const l = (next: Theme): void => setT(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return t;
}
