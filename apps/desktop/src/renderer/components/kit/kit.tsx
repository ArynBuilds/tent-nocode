import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import styles from './kit.module.css';

// The settings building blocks, shared by every settings-like screen: section head, group, row, status line, copy, inline confirm.

export type RowState =
  | { phase: 'idle' }
  | { phase: 'working'; sentence: string }
  | { phase: 'done'; sentence: string; url?: string }
  | { phase: 'failed'; sentence: string; detail?: string };

export const IDLE: RowState = { phase: 'idle' };

/** A write's two failure layers: the envelope's error, then the handler's own refusal inside data. */
export function refusalOf(res: { ok: boolean; error?: string; data?: unknown }): string | null {
  if (!res.ok) return res.error ?? 'Something went wrong.';
  const inner = res.data as { ok?: boolean; error?: string } | undefined;
  return inner !== undefined && inner !== null && inner.ok === false ? (inner.error ?? 'Refused.') : null;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SectionHead({ title, description }: { title: string; description: string }) {
  return (
    <header className={styles.head}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{description}</p>
    </header>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      {title !== undefined ? <h3 className={styles.groupTitle}>{title}</h3> : null}
      <div className={styles.panel}>{children}</div>
    </section>
  );
}

/** Label and hint on the left, the control on the right; `stack` puts the control under the label. */
export function Row({ label, hint, htmlFor, stack = false, children }: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  stack?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={stack ? `${styles.row} ${styles.rowStack}` : styles.row}>
      <div className={styles.rowText}>
        <label className={styles.label} htmlFor={htmlFor}>{label}</label>
        {hint !== undefined ? <div className={styles.hint}>{hint}</div> : null}
      </div>
      {children !== undefined ? <div className={styles.control}>{children}</div> : null}
    </div>
  );
}

/** One saved thing in a list: its record-verbatim name, a quiet line under it, its verbs on the right. */
export function Item({ name, note, children }: { name: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.itemName}>{name}</span>
        {note !== undefined ? <div className={styles.hint}>{note}</div> : null}
      </div>
      {children !== undefined ? <div className={styles.control}>{children}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={copy} aria-label={`${label}: ${value}`}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}

/** A value meant to be copied: mono text in a well, the copy verb beside it. */
export function CopyValue({ value }: { value: string }) {
  return (
    <div className={styles.copyValue}>
      <code className={styles.copyText}>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function StatusLine({ state }: { state: RowState }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'working') return <div className={`${styles.status} ${styles.busy}`} role="status">{state.sentence}</div>;
  if (state.phase === 'failed') {
    return (
      <div className={`${styles.status} ${styles.bad}`} role="alert">
        <span>{state.sentence}</span>
        {state.detail !== undefined && state.detail !== '' ? (
          <details className={styles.details}>
            <summary>Show details</summary>
            <pre>{state.detail}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  const url = state.url;
  return (
    <div className={`${styles.status} ${styles.ok}`} role="status">
      <span>{state.sentence}</span>
      {url !== undefined ? (
        <div className={styles.copyValue}>
          <code className={styles.copyText}>{url}</code>
          <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={() => window.open(url, '_blank')}>
            <ExternalLink size={14} />
            <span>Open</span>
          </button>
          <CopyButton value={url} />
        </div>
      ) : null}
    </div>
  );
}

/** A destructive verb asks once more in place; Esc or Cancel steps back, the takeover keeps its Esc. */
export function ConfirmAction({ label, prompt, confirmLabel, workingLabel, disabled = false, onConfirm }: {
  label: string;
  prompt: string;
  confirmLabel: string;
  workingLabel: string;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const armRef = useRef<HTMLButtonElement | null>(null);
  const wasArmed = useRef(false);
  useEffect(() => {
    if (armed) cancelRef.current?.focus();
    else if (wasArmed.current) armRef.current?.focus();
    wasArmed.current = armed;
  }, [armed]);

  if (!armed) {
    return (
      <button ref={armRef} type="button" className={styles.btn} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  const confirm = (): void => {
    setBusy(true);
    void onConfirm().finally(() => { setBusy(false); setArmed(false); });
  };
  return (
    <div
      className={styles.confirm}
      role="group"
      aria-label={prompt}
      data-own-escape=""
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || busy) return;
        e.stopPropagation();
        setArmed(false);
      }}
    >
      <span className={styles.confirmPrompt}>{prompt}</span>
      <button ref={cancelRef} type="button" className={`${styles.btn} ${styles.btnQuiet}`} disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </button>
      <button type="button" className={`${styles.btn} ${styles.btnStrong}`} disabled={busy} onClick={confirm}>
        {busy ? workingLabel : confirmLabel}
      </button>
    </div>
  );
}

export { styles as kit };
