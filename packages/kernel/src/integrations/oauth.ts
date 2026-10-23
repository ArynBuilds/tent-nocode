// Platform-held OAuth flow: signed state, server-side code exchange, tokens sealed into the vault.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { setSecretValue } from '../secrets/store.js';
import { resolveIntegrationDef, type IntegrationDef } from './catalog.js';
import { getIntegrationConnection } from './connections.js';

const ACTOR = 'kernel.integrations';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OauthClientCreds { id: string; secret: string }
// Looks up client credentials from env; null means not registered yet.
export type OauthClientLookup = (clientEnv: string) => OauthClientCreds | null;

// Vault names a connection's tokens seal under.
export function oauthSecretNames(connectionId: string): { access: string; refresh: string } {
  const key = connectionId.replace(/-/g, '').toUpperCase();
  return { access: `OAUTH_${key}_ACCESS`, refresh: `OAUTH_${key}_REFRESH` };
}

export function signOauthState(appTokenSecret: string, input: { connectionId: string; orgId: string; now?: number }): string {
  const exp = (input.now ?? Date.now()) + STATE_TTL_MS;
  const body = `${input.connectionId}.${input.orgId}.${exp}`;
  const sig = createHmac('sha256', appTokenSecret).update(body, 'utf8').digest('base64url');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sig}`;
}

export function verifyOauthState(appTokenSecret: string, state: string, now = Date.now()):
  | { ok: true; connectionId: string; orgId: string }
  | { ok: false } {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return { ok: false };
  const bodyB64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  let body: string;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  } catch {
    return { ok: false };
  }
  const expected = createHmac('sha256', appTokenSecret).update(body, 'utf8').digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  const [connectionId, orgId, expRaw] = body.split('.');
  if (!connectionId || !orgId || !expRaw) return { ok: false };
  if (Number(expRaw) < now) return { ok: false };
  return { ok: true, connectionId, orgId };
}

// Build the authorize URL the browser opens.
export function buildAuthorizeUrl(def: IntegrationDef, clientId: string, redirectUri: string, state: string): string | null {
  if (def.auth.kind !== 'oauth') return null;
  let u: URL;
  try {
    u = new URL(def.auth.authUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  // A scope-less vendor gets no scope param at all.
  if (def.auth.scopes.length > 0) u.searchParams.set('scope', def.auth.scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export interface OauthTokens { access: string; refresh: string | null; expiresIn: number | null }

// Exchange a code or refresh token server-side via form POST.
export async function exchangeOauthCode(
  fetchImpl: typeof fetch,
  def: IntegrationDef,
  input: { grant: 'authorization_code'; code: string; redirectUri: string; creds: OauthClientCreds }
    | { grant: 'refresh_token'; refreshToken: string; creds: OauthClientCreds },
): Promise<OauthTokens | null> {
  if (def.auth.kind !== 'oauth') return null;
  const form = new URLSearchParams();
  form.set('client_id', input.creds.id);
  form.set('client_secret', input.creds.secret);
  form.set('grant_type', input.grant);
  if (input.grant === 'authorization_code') {
    form.set('code', input.code);
    form.set('redirect_uri', input.redirectUri);
  } else {
    form.set('refresh_token', input.refreshToken);
  }
  let res: Response;
  try {
    res = await fetchImpl(def.auth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const access = typeof data['access_token'] === 'string' ? data['access_token'] : null;
  if (!access) return null;
  return {
    access,
    refresh: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : null,
    expiresIn: typeof data['expires_in'] === 'number' ? data['expires_in'] : null,
  };
}

// Seal tokens per connection; refresh kept only when given.
export async function sealOauthTokens(
  sql: postgres.Sql,
  masterKey: Buffer,
  connection: { id: string; org_id: string; project_id: string },
  tokens: OauthTokens,
  by: string,
): Promise<void> {
  const names = oauthSecretNames(connection.id);
  await setSecretValue(sql, masterKey, { orgId: connection.org_id, projectId: connection.project_id, name: names.access, value: tokens.access, createdBy: by });
  if (tokens.refresh !== null) {
    await setSecretValue(sql, masterKey, { orgId: connection.org_id, projectId: connection.project_id, name: names.refresh, value: tokens.refresh, createdBy: by });
  }
}

// Handle the callback: verify state, exchange code, seal tokens, flip the connection active.
export async function handleOauthCallback(
  sql: postgres.Sql,
  deps: { masterKey: Buffer | null; appTokenSecret: string; redirectUri: string; clients: OauthClientLookup; fetchImpl?: typeof fetch },
  input: { code: string; state: string },
): Promise<{ ok: boolean; sentence: string }> {
  const state = verifyOauthState(deps.appTokenSecret, input.state);
  if (!state.ok) return { ok: false, sentence: 'this sign-in link expired - start again from the app' };
  if (!deps.masterKey) return { ok: false, sentence: 'this host cannot hold sign-ins' };
  const connection = await getIntegrationConnection(sql, state.orgId, state.connectionId);
  if (!connection || connection.revoked_at) return { ok: false, sentence: 'that connection is already gone' };
  const def = resolveIntegrationDef(connection.integration, connection.version);
  if (!def || def.auth.kind !== 'oauth') return { ok: false, sentence: 'that connection does not sign in this way' };
  const creds = deps.clients(def.auth.clientEnv);
  if (!creds) return { ok: false, sentence: `${def.displayName} is upcoming - it connects the moment its approval clears` };
  const tokens = await exchangeOauthCode(deps.fetchImpl ?? fetch, def, {
    grant: 'authorization_code', code: input.code, redirectUri: deps.redirectUri, creds,
  });
  if (!tokens) return { ok: false, sentence: `${def.displayName} did not accept the sign-in - try again from the app` };
  await sealOauthTokens(sql, deps.masterKey, connection, tokens, 'oauth');
  await sql`update integration_connections set status = 'active' where id = ${connection.id}`;
  await emitEvent(sql, {
    orgId: connection.org_id, actor: ACTOR, type: 'integration.connected',
    payload: { connectionId: connection.id, integration: def.name, version: def.version, oauth: true },
  });
  return { ok: true, sentence: `${def.displayName} is connected - you can close this window` };
}
