import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

// CodeMirror 6 editor with language support and design-system theming.

const langCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

const tokenTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--t1)', fontSize: '12.5px', height: '100%' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--t0)' },
  '.cm-cursor': { borderLeftColor: 'var(--t0)' },
  '.cm-gutters': { backgroundColor: 'var(--side)', color: 'var(--t3)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--panel2) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--t1)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--t3) 25%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--t1)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--amber) 30%, transparent)' },
}, { dark: true });

export function languageFor(pathOrName: string): 'python' | 'javascript' {
  return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(pathOrName) ? 'javascript' : 'python';
}

export interface CmHandle {
  view: EditorView;
  getText(): string;
  setText(text: string, language: 'python' | 'javascript'): void;
  // Current selection text and 1-based line range.
  selection(): { text: string; fromLine: number; toLine: number } | null;
  destroy(): void;
}

export function mountEditor(parent: HTMLElement, opts: {
  doc: string;
  language: 'python' | 'javascript';
  onChange?: () => void;
}): CmHandle {
  const view = new EditorView({
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        basicSetup,
        langCompartment.of(opts.language === 'javascript' ? javascript() : python()),
        readOnlyCompartment.of([]),
        tokenTheme,
        EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange?.(); }),
      ],
    }),
    parent,
  });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (text, language) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: langCompartment.reconfigure(language === 'javascript' ? javascript() : python()),
      });
    },
    selection: () => {
      const sel = view.state.selection.main;
      if (sel.empty) return null;
      return {
        text: view.state.sliceDoc(sel.from, sel.to),
        fromLine: view.state.doc.lineAt(sel.from).number,
        toLine: view.state.doc.lineAt(sel.to).number,
      };
    },
    destroy: () => view.destroy(),
  };
}
