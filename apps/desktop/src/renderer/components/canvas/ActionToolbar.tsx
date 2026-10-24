import { Ellipsis, Plus, SquarePlus, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CitizenKind, VerbDoor } from '@nodeloom/core';
import { DOOR_ICONS, foldIcon, kindIcon, unfoldIcon } from '../../lib/canvas/store.js';
import styles from './chrome.module.css';

/**
 * ㊻ (user-ruled 2026-08-05): THE ACTION TOOLBAR — the one shared floating strip,
 * summoned by SELECTION alone ("when we select anything, when we click on anything,
 * then that tooltip shows. When it's not selected, then it's not gonna be shown").
 * HoverToolbar died into this file: hover summons nothing anymore, so the safe-
 * triangle hold props (the float ref + enter/leave pair) died with the hover era. ICONS
 * ONLY, ZERO TEXT (aria carries the meaning silently); constant screen size (the
 * unscaled chrome overlay); backplated, monochrome, generous hits. Buttons are
 * projected from THE NODE CONTRACT (toolbarFor) — this file only knows the renderer
 * icon vocabulary per DOOR name, never per citizen kind.
 */

export interface ToolbarButton {
  key: string;
  icon: LucideIcon;
  /** aria only — never rendered, never a tooltip. */
  label: string;
  onAct: () => void;
}

/** A declared verb's button (the store's icon-per-door row; the menu wears the same face). */
export function doorButton(door: VerbDoor, onAct: () => void): ToolbarButton {
  const d = DOOR_ICONS[door];
  return { key: door, icon: d.icon, label: d.label, onAct };
}

export function propsButton(onAct: () => void): ToolbarButton {
  return { key: 'props', icon: Ellipsis, label: 'Properties', onAct };
}

export function connectButton(onAct: () => void): ToolbarButton {
  return { key: 'connect', icon: Plus, label: 'Connect', onAct };
}

// Fold as a verb: a folded group's strip carries unfold; a foldable selection's strip carries fold.

export function foldButton(onAct: () => void): ToolbarButton {
  return { key: 'fold', icon: foldIcon, label: 'Fold into one', onAct };
}

export function unfoldButton(onAct: () => void): ToolbarButton {
  return { key: 'unfold', icon: unfoldIcon, label: 'Unfold', onAct };
}

export function spliceButton(onAct: () => void): ToolbarButton {
  return { key: 'splice', icon: Plus, label: 'Insert into this connection', onAct };
}

export function removeButton(onAct: () => void): ToolbarButton {
  return { key: 'remove', icon: X, label: 'Delete this connection', onAct };
}

// ---- G3b THE LENS WAVE — the lens element doors, same vocabulary (ONE ICON LANGUAGE):
// a concept with an existing face REUSES it (attach targets wear their citizen icons;
// ▸run rides doorButton('run-operation')); lens-only doors mint from the same Lucide set.

/** An attach door (ELEMENT_PORTS): the target kind's own face, the rule's word as aria. */
export function attachButton(target: CitizenKind, word: string, onAct: () => void): ToolbarButton {
  return { key: `attach:${target}`, icon: kindIcon(target), label: word, onAct };
}

/** ➕ new-view-under-this (nav-only, user-ruled) — minted: a frame with a + (create). */
export function newViewButton(onAct: () => void): ToolbarButton {
  return { key: 'new-view', icon: SquarePlus, label: 'Create a view and link it under this', onAct };
}

export function ActionToolbar({ x, y, buttons }: {
  /** Screen px within the canvas viewport; the strip centers above this point —
   * offset so it never covers its target. */
  x: number;
  y: number;
  buttons: ToolbarButton[];
}) {
  if (buttons.length === 0) return null;
  return (
    <div
      className={styles.toolbar}
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {buttons.map((b) => (
        <button
          key={b.key} type="button" className={styles.toolbarBtn} aria-label={b.label}
          onClick={(e) => { e.stopPropagation(); b.onAct(); }}
        >
          <b.icon size={15} />
        </button>
      ))}
    </div>
  );
}
