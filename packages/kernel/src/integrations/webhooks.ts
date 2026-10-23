// Inbound webhook door: token URLs, vault-sealed signing secrets, timing-safe signature verification.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { deleteSecretValue, resolveSecretValue, setSecretValue } from '../secrets/store.js';
import { holdForCallerAnswer, type WebhookHoldOptions } from './webhookAnswer.js';

const ACTOR = 'kernel.integrations';
// Fixed daily abuse brake on a public door.
const EVENTS_PER_DAY_CAP = 10000;

// The one registry of vendor signature dialects; every surface derives from it.
export const WEBHOOK_SCHEMES = [
  'generic', 'stripe', 'paddle', 'slack', 'linear', 'gitlab', 'calendly', 'telegram', 'box',
] as const;
export type WebhookScheme = (typeof WEBHOOK_SCHEMES)[number];

// Which dialect a service's endpoint speaks, keyed by def slug; unlisted services mint generic endpoints.
export const WEBHOOK_SCHEME_BY_SERVICE: Record<string, WebhookScheme> = {
  'stripe': 'stripe',
  'paddle': 'paddle',
  'lemon-squeezy': 'generic',
  'slack': 'slack',
  'linear': 'linear',
  'gitlab': 'gitlab',
  'calendly': 'calendly',
  'telegram': 'telegram',
  'box': 'box',
};

export interface WebhookEndpointRow {
  id: string;
  org_id: string;
  project_id: string;
  token: string;
  label: string;
  secret_name: string;
  scheme: WebhookScheme;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}

// Mint an endpoint; the signing secret returns once and seals in the vault.
export async function createWebhookEndpoint(
  sql: postgres.Sql,
  masterKey: Buffer | null,
  input: { orgId: string; projectId: string; label: string; createdBy: string; scheme?: WebhookScheme; secret?: string },
): Promise<{ ok: true; endpoint: WebhookEndpointRow; secret: string } | { ok: false; refusal: string }> {
  if (!masterKey) return { ok: false, refusal: 'this host holds no vault key - webhook endpoints need the vault key' };
  const scheme = input.scheme ?? 'generic';
  if (input.secret !== undefined && (input.secret.trim().length < 8 || input.secret.length > 200)) {
    return { ok: false, refusal: 'that signing secret does not look right - paste it exactly as the service shows it' };
  }
  const token = randomBytes(18).toString('base64url');
  const secret = input.secret?.trim() ?? `whsec_${randomBytes(32).toString('hex')}`;
  const secretName = `webhook-in-${token}`;
  await setSecretValue(sql, masterKey, { orgId: input.orgId, projectId: input.projectId, name: secretName, value: secret, createdBy: input.createdBy });
  const [row] = await sql<WebhookEndpointRow[]>`
    insert into webhook_endpoints (org_id, project_id, token, label, secret_name, scheme, created_by)
    values (${input.orgId}, ${input.projectId}, ${token}, ${input.label}, ${secretName}, ${scheme}, ${input.createdBy})
    returning *`;
  if (!row) return { ok: false, refusal: 'the endpoint could not be saved' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'webhook_endpoint.created',
    payload: { endpointId: row.id, label: row.label },
  });
  return { ok: true, endpoint: row, secret };
}

export async function listWebhookEndpoints(
  sql: postgres.Sql,
  input: { orgId: string; projectId?: string },
): Promise<WebhookEndpointRow[]> {
  if (input.projectId) {
    return sql<WebhookEndpointRow[]>`
      select * from webhook_endpoints
      where org_id = ${input.orgId} and project_id = ${input.projectId} and revoked_at is null
      order by created_at asc`;
  }
  return sql<WebhookEndpointRow[]>`
    select * from webhook_endpoints where org_id = ${input.orgId} and revoked_at is null order by created_at asc`;
}

// Tombstone the endpoint and hard-delete its vault secret.
export async function revokeWebhookEndpoint(
  sql: postgres.Sql,
  input: { orgId: string; id: string; by: string },
): Promise<{ ok: true } | { ok: false; refusal: string }> {
  const [row] = await sql<{ id: string; project_id: string; secret_name: string }[]>`
    update webhook_endpoints set revoked_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
    returning id, project_id, secret_name`;
  if (!row) return { ok: false, refusal: 'that endpoint is already gone' };
  await deleteSecretValue(sql, { orgId: input.orgId, projectId: row.project_id, name: row.secret_name });
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'webhook_endpoint.revoked',
    payload: { endpointId: row.id, by: input.by },
  });
  return { ok: true };
}

export interface ReceiveVerdict {
  /** 200/201 carry `body`; every other landed event answers 204. */
  status: 200 | 201 | 204 | 401 | 404 | 413 | 429 | 503;
  sentence?: string;
  body?: string;
}

// One five-minute window serves every timestamp-pinned dialect.
const SIGNED_TS_TOLERANCE_S = 300;

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

// Timing-safe string equality for every signature and token compare.
function sigMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Stripe's t=<ts>,v1=<sig> grammar over `ts.rawBody`; calendly speaks the same math.
function stripeStyleOk(header: string, secret: string, rawBody: string, nowMs: number): boolean {
  const parts = header.split(',').map((p) => p.trim());
  const ts = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!/^\d+$/.test(ts) || sigs.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > SIGNED_TS_TOLERANCE_S) return false;
  const expected = hmacHex(secret, `${ts}.${rawBody}`);
  return sigs.some((s) => sigMatches(s, expected));
}

// Per-scheme signature check over the arriving headers (names lowercased).
export function webhookSignatureOk(
  scheme: WebhookScheme,
  secret: string,
  rawBody: string,
  headers: Record<string, string>,
  nowMs = Date.now(),
): boolean {
  if (scheme === 'stripe') {
    return stripeStyleOk(headers['stripe-signature'] ?? '', secret, rawBody, nowMs);
  }
  if (scheme === 'calendly') {
    return stripeStyleOk(headers['calendly-webhook-signature'] ?? '', secret, rawBody, nowMs);
  }
  if (scheme === 'paddle') {
    const parts = (headers['paddle-signature'] ?? '').split(';').map((p) => p.trim());
    const ts = parts.find((p) => p.startsWith('ts='))?.slice(3) ?? '';
    const sig = parts.find((p) => p.startsWith('h1='))?.slice(3) ?? '';
    if (!/^\d+$/.test(ts) || sig === '') return false;
    if (Math.abs(nowMs / 1000 - Number(ts)) > SIGNED_TS_TOLERANCE_S) return false;
    return sigMatches(sig, hmacHex(secret, `${ts}:${rawBody}`));
  }
  if (scheme === 'slack') {
    // v0=<hex HMAC-SHA256 over "v0:{ts}:{rawBody}">, timestamp pinned.
    const ts = headers['x-slack-request-timestamp'] ?? '';
    const sig = headers['x-slack-signature'] ?? '';
    if (!/^\d+$/.test(ts) || !sig.startsWith('v0=')) return false;
    if (Math.abs(nowMs / 1000 - Number(ts)) > SIGNED_TS_TOLERANCE_S) return false;
    return sigMatches(sig.slice(3), hmacHex(secret, `v0:${ts}:${rawBody}`));
  }
  if (scheme === 'linear') {
    // HMAC-SHA256 hex over the raw body under Linear's own header.
    const sig = headers['linear-signature'] ?? '';
    return sig !== '' && sigMatches(sig, hmacHex(secret, rawBody));
  }
  if (scheme === 'gitlab') {
    // No HMAC: the stored secret travels verbatim as X-Gitlab-Token.
    const token = headers['x-gitlab-token'] ?? '';
    return token !== '' && sigMatches(token, secret);
  }
  if (scheme === 'telegram') {
    // The secret set at setWebhook echoes back verbatim, plain equality.
    const token = headers['x-telegram-bot-api-secret-token'] ?? '';
    return token !== '' && sigMatches(token, secret);
  }
  if (scheme === 'box') {
    // HMAC-SHA256 base64 over rawBody + delivery timestamp; either dual-key header may match.
    const ts = headers['box-delivery-timestamp'] ?? '';
    if (ts === '') return false;
    const expected = createHmac('sha256', secret).update(rawBody + ts, 'utf8').digest('base64');
    const primary = headers['box-signature-primary'] ?? '';
    const secondary = headers['box-signature-secondary'] ?? '';
    return (primary !== '' && sigMatches(primary, expected))
      || (secondary !== '' && sigMatches(secondary, expected));
  }
  const raw = headers['x-tent-nocode-signature'] ?? headers['x-signature'] ?? '';
  const provided = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw;
  if (provided === '') return false;
  return sigMatches(provided, hmacHex(secret, rawBody));
}

// Receive a webhook: 404 quiet on unknown tokens, refuse bad signatures, land verified events.
export async function receiveWebhook(
  sql: postgres.Sql,
  masterKey: Buffer | null,
  input: { token: string; rawBody: string; headers: Record<string, string>; hold?: WebhookHoldOptions },
): Promise<ReceiveVerdict> {
  const [endpoint] = await sql<WebhookEndpointRow[]>`
    select * from webhook_endpoints where token = ${input.token} and revoked_at is null`;
  if (!endpoint) return { status: 404 };
  if (!masterKey) return { status: 503, sentence: 'this host cannot verify webhooks' };

  const [count] = await sql<{ n: string }[]>`
    select count(*) as n from integration_webhook_events
    where endpoint_id = ${endpoint.id} and created_at >= date_trunc('day', now())`;
  if (Number(count?.n ?? 0) >= EVENTS_PER_DAY_CAP) {
    return { status: 429, sentence: 'this endpoint reached its daily event budget' };
  }

  const secret = await resolveSecretValue(sql, masterKey, { orgId: endpoint.org_id, projectId: endpoint.project_id, name: endpoint.secret_name });
  if (!secret) return { status: 503, sentence: 'this endpoint lost its signing secret - revoke it and mint a new one' };

  if (!webhookSignatureOk(endpoint.scheme, secret, input.rawBody, input.headers)) {
    return { status: 401, sentence: 'the signature does not match - the request was not signed with this endpoint\'s secret' };
  }

  // Parse ladder: urlencoded fields verbatim, then JSON, then a raw slice.
  let payload: unknown;
  const contentType = input.headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(input.rawBody)) fields[k] = v;
    payload = fields;
  } else {
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      payload = { raw: input.rawBody.slice(0, 8000) };
    }
  }

  // Slack's url_verification handshake echoes the challenge; no row lands, no trigger fires.
  if (endpoint.scheme === 'slack' && payload !== null && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (p['type'] === 'url_verification' && typeof p['challenge'] === 'string') {
      return { status: 200, body: JSON.stringify({ challenge: p['challenge'] }) };
    }
  }
  const [event] = await sql<{ id: string }[]>`
    insert into integration_webhook_events (org_id, project_id, endpoint_id, payload)
    values (${endpoint.org_id}, ${endpoint.project_id}, ${endpoint.id}, ${sql.json(payload as postgres.JSONValue)})
    returning id`;
  await emitEvent(sql, {
    orgId: endpoint.org_id, actor: ACTOR, type: 'integration.webhook_received',
    payload: { endpointId: endpoint.id, eventId: event?.id ?? null, bytes: input.rawBody.length },
  });
  // An answering flow holds the caller for the run's recorded answer; otherwise 204.
  if (event !== undefined) {
    const held = await holdForCallerAnswer(sql, {
      orgId: endpoint.org_id, token: input.token, eventId: String(event.id),
    }, input.hold);
    if (held !== null) return { status: held.status, body: JSON.stringify({ answer: held.answer }) };
  }
  return { status: 204 };
}
