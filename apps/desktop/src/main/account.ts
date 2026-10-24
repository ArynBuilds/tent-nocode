import { app } from 'electron';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mintAccountToken } from '@nodeloom/server/accountToken';
import type { AuthState, MutationResult, SignUpInput } from '../shared/ipc.js';
import { openSecret, sealSecret, vaultAvailable } from './vault.js';

// THE LOCAL ACCOUNT: one sign-up per computer, kept in userData; the password unlocks the app each launch.
// The token secret and the vault key are this install's own; tokens mint here and never reach the renderer.

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const TOKEN_TTL_SECONDS = 3600;

interface StoredAccount {
  userId: string;
  name: string;
  email: string;
  salt: string;
  hash: string;
}

export interface HostSecrets {
  tokenSecret: string;
  /** The vault master key, 64 hex chars. */
  vaultKey: string;
}

let account: StoredAccount | null = null;
let unlocked = false;
let pendingError: string | null = null;
let secrets: HostSecrets | null = null;
let notify: (state: AuthState) => void = () => {};

const accountFile = (): string => join(app.getPath('userData'), 'account.json');
const secretsFile = (): string => join(app.getPath('userData'), 'host-secrets');

export function onAuthStateChange(cb: (state: AuthState) => void): void {
  notify = cb;
}

export function authState(): AuthState {
  if (account === null) return { status: 'needs-sign-up', email: null, displayName: null, pendingError };
  return { status: unlocked ? 'signed-in' : 'signed-out', email: account.email, displayName: account.name, pendingError };
}

const push = (): void => notify(authState());

/** This install's secrets: made once, sealed by the OS keychain when it is there. */
export async function loadHostSecrets(): Promise<HostSecrets> {
  if (secrets !== null) return secrets;
  try {
    const raw = await readFile(secretsFile(), 'utf8');
    secrets = JSON.parse(raw.startsWith('{') ? raw : openSecret(raw)) as HostSecrets;
  } catch {
    secrets = { tokenSecret: randomBytes(32).toString('hex'), vaultKey: randomBytes(32).toString('hex') };
    const body = JSON.stringify(secrets);
    await writeFile(secretsFile(), vaultAvailable() ? sealSecret(body) : body, { encoding: 'utf8', mode: 0o600 });
  }
  return secrets;
}

/** Boot: read the account if one exists; the app stays locked until the password is given. */
export async function loadAccountAtBoot(): Promise<void> {
  try {
    account = JSON.parse(await readFile(accountFile(), 'utf8')) as StoredAccount;
  } catch {
    account = null;
  }
  unlocked = false;
  push();
}

/** The live access token, main-process only; null while locked. */
export function sessionAccessToken(): string | null {
  if (account === null || !unlocked || secrets === null) return null;
  return mintAccountToken({ userId: account.userId, email: account.email, displayName: account.name }, secrets.tokenSecret, TOKEN_TTL_SECONDS);
}

async function hashOf(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password, salt, 64);
}

export async function signUp(input: SignUpInput): Promise<MutationResult<undefined>> {
  if (account !== null) return { ok: false, error: 'An account already exists on this computer. Unlock it with its password.' };
  const name = input.name.trim();
  const email = input.email.trim();
  if (name === '') return { ok: false, error: 'Enter your name.' };
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, error: 'Enter an email address.' };
  if (input.password.length < 8) return { ok: false, error: 'The password needs at least 8 characters.' };
  const salt = randomBytes(16);
  const next: StoredAccount = {
    userId: randomUUID(), name, email, salt: salt.toString('hex'), hash: (await hashOf(input.password, salt)).toString('hex'),
  };
  await writeFile(accountFile(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  account = next;
  unlocked = true;
  pendingError = null;
  push();
  return { ok: true };
}

export async function signIn(password: string): Promise<MutationResult<undefined>> {
  if (account === null) return { ok: false, error: 'There is no account on this computer yet. Create one first.' };
  const given = await hashOf(password, Buffer.from(account.salt, 'hex'));
  const stored = Buffer.from(account.hash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    pendingError = 'That password is not right.';
    push();
    return { ok: false, error: pendingError };
  }
  unlocked = true;
  pendingError = null;
  push();
  return { ok: true };
}

/** Locks the app; the account and everything built stay on this computer. */
export async function signOut(): Promise<void> {
  unlocked = false;
  pendingError = null;
  push();
}
