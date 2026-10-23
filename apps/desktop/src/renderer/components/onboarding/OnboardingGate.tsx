import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthState } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import type { GateStep } from '../../lib/gate.js';
import styles from './onboarding.module.css';

// The onboarding gate: the one-time local sign-up, or the password that unlocks this computer's account.

function Field({ label, type = 'text', value, onChange, autoFocus = false }: {
  label: string;
  type?: 'text' | 'email' | 'password';
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <input className={styles.input} type={type} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SignUpForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = name.trim() !== '' && email.trim() !== '' && password !== '' && repeat !== '';

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!filled || busy) return;
    if (password !== repeat) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError(null);
    void desk.signUp({ name: name.trim(), email: email.trim(), password })
      .then((res) => { if (!res.ok) setError(res.error); })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.title}>Create your account</div>
      <div className={styles.quiet}>Your account and everything you build stay on this computer.</div>
      <Field label="Name" value={name} onChange={setName} autoFocus />
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <Field label="Password" type="password" value={password} onChange={setPassword} />
      <Field label="Repeat password" type="password" value={repeat} onChange={setRepeat} />
      {error !== null ? <div className={styles.error}>{error}</div> : null}
      <button type="submit" className={styles.primary} disabled={!filled || busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}

function UnlockForm({ auth }: { auth: AuthState | null }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A named failure pushed from the main process shows in place.
  useEffect(() => {
    if (auth?.pendingError != null) setError(auth.pendingError);
  }, [auth?.pendingError]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (password === '' || busy) return;
    setBusy(true);
    setError(null);
    void desk.signIn(password)
      .then((res) => { if (!res.ok) setError(res.error); })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.title}>{auth?.displayName ?? 'Welcome back'}</div>
      {auth?.email != null ? <div className={styles.quiet}>{auth.email}</div> : null}
      <Field label="Password" type="password" value={password} onChange={setPassword} autoFocus />
      {error !== null ? <div className={styles.error}>{error}</div> : null}
      <button type="submit" className={styles.primary} disabled={password === '' || busy}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  );
}

export function OnboardingGate({ step, auth }: {
  step: Exclude<GateStep, 'open'>;
  auth: AuthState | null;
}) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>Tent NoCode</div>
        {step === 'loading' ? <div className={styles.quiet}>starting…</div> : null}
        {step === 'sign-up' ? <SignUpForm /> : null}
        {step === 'unlock' ? <UnlockForm auth={auth} /> : null}
      </div>
    </div>
  );
}
