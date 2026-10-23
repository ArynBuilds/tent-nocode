import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { AuthState } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import type { GateStep } from '../../lib/gate.js';
import { Logo } from '../brand/Logo.js';
import { Group, IDLE, Row, StatusLine, errorText, kit, type RowState } from '../kit/kit.js';
import { Titlebar } from '../shell/Titlebar.js';
import { Showcase } from './Showcase.js';
import styles from './onboarding.module.css';

// The onboarding gate: the one-time local sign-up in two short steps, or the password that unlocks this computer's account.

function Field({ id, label, hint, type = 'text', value, onChange, autoFocus = false, autoComplete }: {
  id: string;
  label: string;
  hint?: string;
  type?: 'text' | 'email' | 'password';
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  autoComplete?: string;
}) {
  return (
    <Row label={label} htmlFor={id} stack {...(hint !== undefined ? { hint } : {})}>
      <input
        id={id}
        className={`${kit.input} ${styles.input}`}
        type={type}
        value={value}
        autoFocus={autoFocus}
        spellCheck={false}
        {...(autoComplete !== undefined ? { autoComplete } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}

function Head({ eyebrow, title, description }: { eyebrow?: string; title: string; description: string }) {
  return (
    <header className={styles.head}>
      {eyebrow !== undefined ? <div className={styles.eyebrow}>{eyebrow}</div> : null}
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
    </header>
  );
}

function Steps({ at }: { at: 1 | 2 }) {
  return (
    <div className={styles.steps} aria-label={`Step ${at} of 2`}>
      <span className={styles.stepOn} />
      <span className={at === 2 ? styles.stepOn : styles.step} />
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function SignUpForm() {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [state, setState] = useState<RowState>(IDLE);
  const busy = state.phase === 'working';

  const next = (e: FormEvent): void => {
    e.preventDefault();
    if (name.trim() === '') { setState({ phase: 'failed', sentence: 'Enter your name.' }); return; }
    if (!EMAIL.test(email.trim())) { setState({ phase: 'failed', sentence: 'Enter an email address.' }); return; }
    setState(IDLE);
    setStep(2);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) { setState({ phase: 'failed', sentence: 'The password needs at least 8 characters.' }); return; }
    if (password !== repeat) { setState({ phase: 'failed', sentence: 'The two passwords do not match.' }); return; }
    setState({ phase: 'working', sentence: 'Creating your account…' });
    void desk.signUp({ name: name.trim(), email: email.trim(), password })
      .then((res) => { if (!res.ok) setState({ phase: 'failed', sentence: res.error }); })
      .catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not create the account.', detail: errorText(err) }));
  };

  if (step === 1) {
    return (
      <form key="one" className={styles.form} onSubmit={next}>
        <Steps at={1} />
        <Head eyebrow="Welcome" title="Let's set you up" description="Your account lives on this computer only, together with everything you build. Nothing is sent anywhere." />
        <Group>
          <Field id="signup-name" label="Your name" value={name} onChange={(v) => { setName(v); setState(IDLE); }} autoFocus autoComplete="name" />
          <Field id="signup-email" label="Email" type="email" value={email} onChange={(v) => { setEmail(v); setState(IDLE); }} autoComplete="email" />
        </Group>
        <div className={styles.foot}>
          <StatusLine state={state} />
          <button type="submit" className={`${kit.btn} ${kit.btnPrimary} ${styles.go}`}>
            Continue
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    );
  }
  return (
    <form key="two" className={styles.form} onSubmit={submit}>
      <Steps at={2} />
      <Head
        eyebrow={`Hi, ${name.trim().split(/\s+/)[0] ?? ''}`}
        title="Choose a password"
        description="It unlocks the app each time you open it. There is no way to reset it, so keep it somewhere safe."
      />
      <Group>
        <Field
          id="signup-password" label="Password" hint="At least 8 characters." type="password" value={password}
          onChange={(v) => { setPassword(v); if (state.phase === 'failed') setState(IDLE); }} autoFocus autoComplete="new-password"
        />
        <Field
          id="signup-repeat" label="Repeat it" type="password" value={repeat}
          onChange={(v) => { setRepeat(v); if (state.phase === 'failed') setState(IDLE); }} autoComplete="new-password"
        />
      </Group>
      <div className={styles.foot}>
        <StatusLine state={state} />
        <div className={styles.footRow}>
          <button type="button" className={`${kit.btn} ${kit.btnQuiet} ${styles.back}`} disabled={busy} onClick={() => { setState(IDLE); setStep(1); }}>
            <ArrowLeft size={15} />
            Back
          </button>
          <button type="submit" className={`${kit.btn} ${kit.btnPrimary} ${styles.go}`} disabled={busy || password === '' || repeat === ''}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </div>
    </form>
  );
}

function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

function UnlockForm({ auth }: { auth: AuthState | null }) {
  const [password, setPassword] = useState('');
  const [state, setState] = useState<RowState>(IDLE);
  const [shake, setShake] = useState(0);
  const busy = state.phase === 'working';
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A named failure pushed from the main process shows in place, and the field shakes once.
  useEffect(() => {
    if (auth?.pendingError == null) return;
    setState({ phase: 'failed', sentence: auth.pendingError });
    setShake((n) => n + 1);
    inputRef.current?.select();
  }, [auth?.pendingError]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (password === '' || busy) return;
    setState({ phase: 'working', sentence: 'Unlocking…' });
    void desk.signIn(password)
      .then((res) => {
        if (res.ok) return;
        setState({ phase: 'failed', sentence: res.error });
        setShake((n) => n + 1);
        inputRef.current?.select();
      })
      .catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not unlock.', detail: errorText(err) }));
  };

  const who = auth?.displayName ?? null;
  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.avatar}>{initials(who)}</div>
      <Head
        title={who !== null ? `Welcome back, ${who.split(/\s+/)[0]}` : 'Welcome back'}
        description={auth?.email != null ? `Enter the password for ${auth.email}.` : 'Enter your password to open the app.'}
      />
      <div key={shake} className={shake > 0 ? styles.shake : undefined}>
        <Group>
          <Row label="Password" htmlFor="unlock-password" stack>
            <input
              id="unlock-password"
              ref={inputRef}
              className={`${kit.input} ${styles.input}`}
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              onChange={(e) => { setPassword(e.target.value); if (state.phase === 'failed') setState(IDLE); }}
            />
          </Row>
        </Group>
      </div>
      <div className={styles.foot}>
        <StatusLine state={state} />
        <button type="submit" className={`${kit.btn} ${kit.btnPrimary} ${styles.go}`} disabled={password === '' || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
          {busy ? null : <ArrowRight size={16} />}
        </button>
      </div>
    </form>
  );
}

export function OnboardingGate({ step, auth }: {
  step: Exclude<GateStep, 'open'>;
  auth: AuthState | null;
}) {
  if (step === 'loading') {
    return (
      <div className={styles.gate}>
        <div className={styles.bar}><Titlebar /></div>
        <div className={styles.loading}>
          <Logo size={56} className={styles.loadingMark} title="Tent NoCode is starting" />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.gate}>
      <div className={styles.bar}><Titlebar /></div>
      <div className={`${styles.wrap} ${kit.readable}`}>
        <Showcase />
        <main className={styles.pane}>
          <div className={styles.column}>
            {step === 'sign-up' ? <SignUpForm /> : <UnlockForm auth={auth} />}
          </div>
        </main>
      </div>
    </div>
  );
}
