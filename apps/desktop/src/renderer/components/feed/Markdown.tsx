import type { ReactNode } from 'react';
import { parseInert, type Inline } from '../../lib/markdown/parse.js';
import styles from './feed.module.css';

// Renders inert markdown blocks to elements; no links or injected HTML.

function inlineNodes(runs: Inline[]): ReactNode[] {
  return runs.map((r, i) => {
    switch (r.kind) {
      case 'bold': return <strong key={i}>{r.text}</strong>;
      case 'italic': return <em key={i}>{r.text}</em>;
      case 'code': return <code key={i} className={styles.mdCode}>{r.text}</code>;
      default: return <span key={i}>{r.text}</span>;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseInert(text);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            // Map levels 1-3 to h3/h4/h5 for feed context.
            const Tag = (['h3', 'h4', 'h5'] as const)[b.level - 1]!;
            return <Tag key={i} className={styles.mdHeading}>{inlineNodes(b.inline)}</Tag>;
          }
          case 'code':
            return (
              <pre key={i} className={styles.mdPre}>
                <code>{b.text}</code>
              </pre>
            );
          case 'table':
            // Render pipe tables with horizontal scroll container.
            return (
              <div key={i} className={styles.mdTableWrap}>
                <table className={styles.mdTable}>
                  <thead>
                    <tr>{b.header.map((cell, j) => <th key={j}>{inlineNodes(cell)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>{row.map((cell, k) => <td key={k}>{inlineNodes(cell)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list':
            return b.ordered ? (
              <ol key={i} className={styles.mdList}>
                {b.items.map((item, j) => <li key={j}>{inlineNodes(item)}</li>)}
              </ol>
            ) : (
              <ul key={i} className={styles.mdList}>
                {b.items.map((item, j) => <li key={j}>{inlineNodes(item)}</li>)}
              </ul>
            );
          default:
            return <p key={i} className={styles.mdPara}>{inlineNodes(b.inline)}</p>;
        }
      })}
    </>
  );
}
