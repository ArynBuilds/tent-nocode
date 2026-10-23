import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

// CodeMirror 6 editor with language support and design-system theming.

const langCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

const tokenTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--ground)', color: 'var(--t1)', fontSize: '13px', height: '100%' },
  '.cm-scroller': { lineHeight: '1.6' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--live)', padding: '12px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--live)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--ground)', color: 'var(--t3)', border: 'none', borderRight: 'none', paddingLeft: '8px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--t3)', opacity: '0.5' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 4px', opacity: '0.6' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface) 80%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--t1)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--live) 22%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--t1)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--amber) 30%, transparent)' },
}, { dark: true });

// Code colors come from the --code-* tokens, so both themes stay calm and readable.
const codeColors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--code-function)' },
  { tag: [t.className, t.typeName, t.definition(t.className)], color: 'var(--code-type)' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: 'var(--t1)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--t2)' },
]);

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
        syntaxHighlighting(codeColors),
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
