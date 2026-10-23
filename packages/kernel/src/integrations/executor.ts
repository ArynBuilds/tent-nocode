// The host-locked executor: param validation, URL resolution with a post-resolution host wall, and the call sweep.
// URL breakouts like //evil.com resolve to their real host, so the check must run after resolution.
import type postgres from 'postgres';
import type { IntegrationDef, IntegrationEndpointDef } from './catalog.js';
import { pathSlots } from './catalog.js';
import { getOrgConfig } from '../config.js';
import { recordDatasetAppend } from '../tabs/datasets.js';
import { resolveSecretValue } from '../secrets/store.js';
import { redactSecretValues } from '../secrets/redact.js';
import { claimNextIntegrationExecution, resolveCallTarget, settleIntegrationExecution } from './dispatch.js';
import { exchangeOauthCode, oauthSecretNames, sealOauthTokens, type OauthClientLookup } from './oauth.js';
import type { IntegrationConnectionRow } from './connections.js';

export type IntegrationParamValue = string | number | boolean;
export type IntegrationParams = Record<string, IntegrationParamValue>;

/** Control chars (CR/LF included) in any value are the header/CRLF-injection wall. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Validate params against the endpoint's closed declaration; any mismatch refuses with one plain sentence. */
export function validateIntegrationParams(
  endpoint: IntegrationEndpointDef,
  params: IntegrationParams,
  /** requireAll=false skips the missing-required check at creation; call-time keeps the full check. */
  opts: { requireAll?: boolean } = {},
): { ok: true } | { ok: false; refusal: string } {
  for (const [name, value] of Object.entries(params)) {
    const decl = endpoint.params[name];
    if (!decl) return { ok: false, refusal: `"${endpoint.displayName}" takes no "${name}"` };
    if (typeof value !== decl.type) {
      return { ok: false, refusal: `"${name}" wants a ${decl.type}` };
    }
    if (decl.choices && typeof value === 'string' && !decl.choices.includes(value)) {
      return { ok: false, refusal: `"${name}" must be one of: ${decl.choices.join(', ')}` };
    }
    if (CONTROL_RE.test(String(value))) {
      return { ok: false, refusal: `"${name}" carries characters that cannot ride a request` };
    }
  }
  if (opts.requireAll !== false) {
    for (const [name, decl] of Object.entries(endpoint.params)) {
      if (decl.required && !(name in params)) {
        return { ok: false, refusal: `"${endpoint.displayName}" needs "${name}"` };
      }
    }
  }
  return { ok: true };
}

/** Settings fill unset call params by name or `default_<param>`; explicit params always win; only scalars ride. */
export function paramsWithSettingsDefaults(
  endpoint: IntegrationEndpointDef,
  params: IntegrationParams,
  settings: Record<string, unknown>,
): IntegrationParams {
  const merged: IntegrationParams = { ...params };
  for (const name of Object.keys(endpoint.params)) {
    if (merged[name] !== undefined) continue;
    const candidate = settings[name] ?? settings[`default_${name}`];
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      if (typeof candidate === 'string' && candidate.trim() === '') continue;
      merged[name] = candidate;
    }
  }
  return merged;
}

/** The base host an endpoint calls: a declared catalog host or the Connect-snapshotted owner host. Null = no legal base. */
export function integrationBaseUrl(def: IntegrationDef, endpoint: IntegrationEndpointDef, ownerHost?: string | null): string | null {
  if (!Array.isArray(def.hosts)) {
    if (!ownerHost) return null;
    return ownerHost;
  }
  if (ownerHost && def.hosts.includes(ownerHost)) return ownerHost;
  const base = endpoint.host ?? def.hosts[0];
  if (!base) return null;
  if (endpoint.host && !def.hosts.includes(endpoint.host)) return null;
  return base;
}

/** Resolve the full request URL; null if the result escapes the declared host or leaves https. */
export function resolveIntegrationUrl(
  def: IntegrationDef,
  endpoint: IntegrationEndpointDef,
  params: IntegrationParams,
  ownerHost?: string | null,
  /** Already-encoded path prefix carrying the secret for path auth. */
  authPathPrefix?: string,
): string | null {
  const baseRaw = integrationBaseUrl(def, endpoint, ownerHost);
  if (!baseRaw) return null;
  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:') return null;

  const slots = pathSlots(endpoint.path);
  let path = endpoint.path;
  for (const slot of slots) {
    if (!(slot in endpoint.params)) return null; // undeclared slot - the def is malformed
    const value = params[slot];
    if (value === undefined) return null;
    if (CONTROL_RE.test(String(value))) return null;
    path = path.split(`{${slot}}`).join(encodeURIComponent(String(value)));
  }
  if (def.auth.kind === 'path') {
    if (authPathPrefix === undefined || !authPathPrefix.startsWith('/')) return null;
    path = authPathPrefix + path;
  }

  const rideQuery = endpoint.body === 'query' || ((endpoint.method === 'GET' || endpoint.method === 'DELETE') && endpoint.body === undefined);
  const query = new URLSearchParams();
  if (rideQuery) {
    for (const [name, value] of Object.entries(params)) {
      if (slots.includes(name)) continue;
      const decl = endpoint.params[name];
      if (!decl) return null; // closed: unknown params never ride
      if (CONTROL_RE.test(String(value))) return null;
      // `wire` carries the service's own casing.
      query.set(decl.wire ?? name, String(value));
    }
  }

  let u: URL;
  try {
    u = new URL(path, base);
  } catch {
    return null;
  }
  const qs = query.toString();
  if (qs) u.search = u.search ? `${u.search}&${qs}` : `?${qs}`;

  // THE WALL: post-resolution, the request must still be https on the declared host.
  if (u.protocol !== 'https:') return null;
  if (u.host !== base.host) return null;
  return u.toString();
}

/** Walk a declared dot path into a parsed response ("data.0.id"). Undefined when absent. */
export function pickPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Deep-set a value at a dot path; numeric segments mint arrays. */
function deepSet(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    const idx = /^\d+$/.test(key) ? Number(key) : null;
    if (idx !== null && Array.isArray(cur)) {
      if (cur[idx] === undefined || cur[idx] === null || typeof cur[idx] !== 'object') cur[idx] = nextIsIndex ? [] : {};
      cur = cur[idx] as Record<string, unknown> | unknown[];
    } else if (idx === null && !Array.isArray(cur)) {
      const obj = cur as Record<string, unknown>;
      if (obj[key] === undefined || obj[key] === null || typeof obj[key] !== 'object') obj[key] = nextIsIndex ? [] : {};
      cur = obj[key] as Record<string, unknown> | unknown[];
    } else {
      return; // shape mismatch - the declared path contradicts itself; leave unset
    }
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(cur) && /^\d+$/.test(last)) cur[Number(last)] = value;
  else if (!Array.isArray(cur)) (cur as Record<string, unknown>)[last] = value;
}

/** Land the call's fields into the node's inside tables: columns fill by name from params then picks; fromArray fans out over the response body. */
export async function feedInsideTables(
  sql: postgres.Sql,
  connection: IntegrationConnectionRow,
  def: IntegrationDef,
  params: IntegrationParams,
  result: unknown,
  rawBody?: unknown,
): Promise<void> {
  const mapping = connection.inside?.tables ?? {};
  const resultObj = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const bodyObj = rawBody !== null && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : resultObj;
  const buildRow = (rowSchema: Record<string, 'string' | 'number' | 'boolean'>, source: Record<string, unknown>, fallback?: Record<string, unknown>): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    for (const [col, type] of Object.entries(rowSchema)) {
      const snake = col.replace(/-/g, '_');
      let v: unknown = source[snake] ?? source[col] ?? fallback?.[snake] ?? fallback?.[col];
      if (v === undefined || v === null) continue;
      if (type === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) v = String(v);
      if (typeof v === type) row[col] = v;
    }
    return row;
  };
  for (const t of def.inside.tables) {
    const datasetName = mapping[t.name];
    if (!datasetName) continue;
    let rows: Record<string, unknown>[];
    if (t.fromArray !== undefined) {
      // One row per element of the declared array, capped at 100.
      const arr = pickPath(bodyObj, t.fromArray);
      rows = Array.isArray(arr)
        ? arr.slice(0, 100)
          .filter((el): el is Record<string, unknown> => el !== null && typeof el === 'object')
          .map((el) => buildRow(t.rowSchema, el))
          .filter((r) => Object.keys(r).length > 0)
        : [];
    } else {
      const row = buildRow(t.rowSchema, params as Record<string, unknown>, resultObj);
      rows = Object.keys(row).length > 0 ? [row] : [];
    }
    if (rows.length === 0) continue;
    await recordDatasetAppend(sql, {
      orgId: connection.org_id,
      projectId: connection.project_id,
      runId: null,
      append: { dataset: datasetName, schema: t.rowSchema, rows },
    });
  }
}

export interface IntegrationExecutorConfig {
  /** The vault master key. Null = a keyless host: auth-carrying calls fail NAMED, auth-none still runs. */
  masterKey: Buffer | null;
  /** OAuth custody: the client-credential lookup (the host's env). Absent = refresh cannot run. */
  oauthClients?: OauthClientLookup;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

// Claim one pending execution, make the one call, settle. Server-side only; 'ran' after any claim, 'idle' when empty.
// Redirects refuse; response kinds allowlist json/text; every stored error/result passes the scrub.
export async function processPendingIntegrationExecutions(
  sql: postgres.Sql,
  cfg: IntegrationExecutorConfig,
): Promise<'ran' | 'idle'> {
  const claim = await claimNextIntegrationExecution(sql);
  if (!claim) return 'idle';
  const scrubValues: string[] = [];
  const scrub = (text: string): string => redactSecretValues(text, scrubValues);
  try {
    const target = await resolveCallTarget(sql, { orgId: claim.org_id, connectionId: claim.connection_id, endpoint: claim.endpoint });
    if (!target.ok) {
      await settleIntegrationExecution(sql, { id: claim.id, ok: false, error: target.refusal });
      return 'ran';
    }
    const { connection, def, endpoint } = target;
    const orgCfg = (await getOrgConfig(sql, claim.org_id)).integrations;

    // Constant headers first; the credential writes last and always wins its own header.
    const headers: Record<string, string> = { ...(def.headers ?? {}), ...(endpoint.headers ?? {}) };
    let secret: string | null = null;
    if (def.auth.kind !== 'none') {
      if (!cfg.masterKey) {
        await settleIntegrationExecution(sql, { id: claim.id, ok: false, error: `${def.displayName} needs its key, and this host holds no vault key` });
        return 'ran';
      }
      const secretName = def.auth.kind === 'oauth' ? oauthSecretNames(connection.id).access : def.auth.secretName;
      secret = await resolveSecretValue(sql, cfg.masterKey, { orgId: claim.org_id, projectId: connection.project_id, name: secretName });
      if (!secret) {
        await settleIntegrationExecution(sql, {
          id: claim.id, ok: false,
          error: def.auth.kind === 'oauth'
            ? `${def.displayName} needs its sign-in - connect it first`
            : `${def.displayName} needs its key - add it when connecting`,
        });
        return 'ran';
      }
      scrubValues.push(secret);
      if (def.auth.kind === 'bearer') headers['authorization'] = `${def.auth.scheme ?? 'Bearer'} ${secret}`;
      else if (def.auth.kind === 'oauth') headers['authorization'] = `Bearer ${secret}`;
      else if (def.auth.kind === 'basic') headers['authorization'] = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
      else if (def.auth.kind === 'header' && def.auth.header) headers[def.auth.header.toLowerCase()] = def.auth.scheme ? `${def.auth.scheme} ${secret}` : secret;
      // query + path kinds inject below, after/at URL resolution.
    }

    const authPathPrefix = def.auth.kind === 'path' && secret !== null
      ? def.auth.template.replace('{secret}', encodeURIComponent(secret))
      : undefined;
    let url = resolveIntegrationUrl(def, endpoint, claim.params, connection.owner_host, authPathPrefix);
    if (!url) {
      await settleIntegrationExecution(sql, { id: claim.id, ok: false, error: 'the call did not resolve on the declared host' });
      return 'ran';
    }
    if (def.auth.kind === 'query' && secret !== null) {
      // Post-resolution injection: the host is already asserted; the secret never rides a declared param.
      const u = new URL(url);
      u.searchParams.set(def.auth.param, secret);
      url = u.toString();
    }

    // Body assembly: `wire` renames on the wire; `at` deep-sets into the json body.
    const slots = new Set(pathSlots(endpoint.path));
    const ridesQuery = endpoint.body === 'query' || ((endpoint.method === 'GET' || endpoint.method === 'DELETE') && endpoint.body === undefined);
    let body: string | undefined;
    if (!ridesQuery) {
      if ((endpoint.body ?? 'json') === 'form') {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(claim.params)) {
          if (slots.has(k)) continue;
          form.set(endpoint.params[k]?.wire ?? k, String(v));
        }
        body = form.toString();
        if (!('content-type' in headers)) headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        const bodyObj: Record<string, unknown> = {};
        // Constant body fields land first; params win on collision.
        for (const [p, v] of Object.entries(endpoint.bodyConstants ?? {})) deepSet(bodyObj, p, v);
        for (const [k, v] of Object.entries(claim.params)) {
          if (slots.has(k)) continue;
          const decl = endpoint.params[k];
          if (decl?.at !== undefined) deepSet(bodyObj, decl.at, v);
          else bodyObj[decl?.wire ?? k] = v;
        }
        // The body-carried secret lands last at its declared dot path, never overridable by a param.
        if (def.auth.kind === 'body' && secret !== null) deepSet(bodyObj, def.auth.at, secret);
        body = JSON.stringify(bodyObj);
        if (!('content-type' in headers)) headers['content-type'] = 'application/json';
      }
    }

    const doFetch = cfg.fetchImpl ?? fetch;
    const fire = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), orgCfg.callTimeoutMs);
      try {
        return await doFetch(url, { method: endpoint.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    let response = await fire();

    // An expired oauth access token refreshes once, then one retry.
    if (response.status === 401 && def.auth.kind === 'oauth' && cfg.masterKey && cfg.oauthClients) {
      const creds = cfg.oauthClients(def.auth.clientEnv);
      const refreshToken = creds
        ? await resolveSecretValue(sql, cfg.masterKey, { orgId: claim.org_id, projectId: connection.project_id, name: oauthSecretNames(connection.id).refresh })
        : null;
      if (creds && refreshToken) {
        scrubValues.push(refreshToken);
        const fresh = await exchangeOauthCode(doFetch, def, { grant: 'refresh_token', refreshToken, creds });
        if (fresh) {
          await sealOauthTokens(sql, cfg.masterKey, connection, fresh, 'oauth-refresh');
          scrubValues.push(fresh.access);
          headers['authorization'] = `Bearer ${fresh.access}`;
          response = await fire();
        }
      }
    }

    if (response.status >= 300 && response.status < 400) {
      await settleIntegrationExecution(sql, {
        id: claim.id, ok: false, httpStatus: response.status,
        error: `${def.displayName} tried to redirect the call - refused, requests stay on the declared host`,
      });
      return 'ran';
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('json');
    if (!isJson && !(contentType.startsWith('text/') || contentType === '')) {
      await settleIntegrationExecution(sql, { id: claim.id, ok: false, httpStatus: response.status, error: `${def.displayName} answered with a response kind this lane does not carry (${contentType.split(';')[0]})` });
      return 'ran';
    }
    const raw = await response.text();
    const clipped = raw.slice(0, orgCfg.responseCapBytes);
    let parsed: unknown = clipped;
    if (isJson) {
      try {
        parsed = JSON.parse(clipped);
      } catch {
        /* over-cap or invalid json - the text form stands */
      }
    }

    if (!response.ok) {
      await settleIntegrationExecution(sql, {
        id: claim.id, ok: false, httpStatus: response.status,
        error: scrub(`${def.displayName} answered ${response.status}: ${clipped.slice(0, 400)}`),
      });
      return 'ran';
    }

    // Picks project the result; without picks, json rides whole (capped) and text clips.
    let result: unknown;
    if (endpoint.picks && endpoint.picks.length > 0) {
      const out: Record<string, unknown> = {};
      for (const pick of endpoint.picks) {
        if ('fromHeader' in pick) out[pick.field] = response.headers.get(pick.fromHeader) ?? null;
        else out[pick.field] = (parsed !== null && typeof parsed === 'object' ? pickPath(parsed, pick.from) : undefined) ?? null;
      }
      result = out;
    } else {
      result = isJson ? parsed : clipped.slice(0, 4000);
    }
    const safeResult: unknown = JSON.parse(scrub(JSON.stringify(result ?? null)));
    await settleIntegrationExecution(sql, { id: claim.id, ok: true, httpStatus: response.status, result: safeResult });
    // Feed the inside tables from the scrubbed result/body; a feed hiccup never unsettles the call.
    const safeBody: unknown = isJson && endpoint.picks && endpoint.picks.length > 0
      ? JSON.parse(scrub(JSON.stringify(parsed ?? null)))
      : safeResult;
    try {
      await feedInsideTables(sql, connection, def, claim.params, safeResult, safeBody);
    } catch {
      /* never-fail feed side-effect */
    }
    // Import-provenance pages land here; a landing failure fails the import, not the call.
    if ((claim.trigger as Record<string, unknown>)['kind'] === 'import') {
      try {
        const { landImportPage } = await import('./importDoor.js');
        await landImportPage(sql, claim, def, safeBody);
      } catch {
        /* the sweep sees the stalled import and fails it on its own evidence */
      }
    }
    return 'ran';
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError'
      ? 'the call took too long and was stopped'
      : err instanceof Error ? err.message : String(err);
    try {
      await settleIntegrationExecution(sql, { id: claim.id, ok: false, error: scrub(message) });
    } catch {
      /* never-fail settle side-effect */
    }
    return 'ran';
  }
}
