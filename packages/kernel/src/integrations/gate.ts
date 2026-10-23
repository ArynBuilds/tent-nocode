// Mechanical checks every integration def must pass before shipping; collects all failures at once.
import { integrationDefSchema, integrationSpecHash, pathSlots, type IntegrationDef, type IntegrationEndpointDef } from './catalog.js';
import { resolveIntegrationUrl, validateIntegrationParams, type IntegrationParams } from './executor.js';

export type GateResult = { ok: true; specHash: string; def: IntegrationDef } | { ok: false; failures: string[] };

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// Attack strings substituted into every slot and string param; the resolver must refuse or stay on-host.
const ATTACK_STRINGS: readonly string[] = [
  '//evil.example',
  'https://evil.example',
  'https://evil.example/x',
  'x@evil.example/',
  ':@evil.example',
  '../../admin',
  '..%2f..%2fadmin',
  '#frag',
  '?q=1&admin=true',
  'x' + CR + LF + 'Host: evil.example',
  'x' + LF + 'X-Injected: 1',
  String.fromCharCode(92) + String.fromCharCode(92) + 'evil.example',
];

// Credential-looking shapes that must never appear in a declaration.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/,
  /xox[abprs]-[A-Za-z0-9-]{8,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ/,
];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;
const METHOD_PREFIX_RE = /^(get|post|put|patch|delete)\b/i;
const MACHINE_WORD_RE = /\b(api|endpoint|endpoints|oauth2?|http|https|url|json)\b/i;

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
}

// Shared host rulebook; null means the host is legal.
export function ownerHostFailure(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `host "${raw}" is not a valid URL`;
  }
  if (u.protocol !== 'https:') return `host "${raw}" must be https`;
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return `host "${raw}" must be a bare origin (no path, query, or fragment)`;
  if (u.username || u.password) return `host "${raw}" must carry no credentials`;
  if (IPV4_RE.test(u.host) || u.host.includes('[')) return `host "${raw}" must be a name, never an IP address`;
  const name = u.hostname.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || !name.includes('.')) {
    return `host "${raw}" points inside - integration hosts are public services`;
  }
  return null;
}

function checkHosts(def: IntegrationDef, fail: (s: string) => void): void {
  if (!Array.isArray(def.hosts)) {
    // Template hosts must fill to a legal origin; owner-pinned hosts arrive at Connect.
    if ('template' in def.hosts) {
      const failure = ownerHostFailure(def.hosts.template.replace(`{${def.hosts.slot}}`, 'gatestand'));
      if (failure) fail(failure);
    }
    return;
  }
  for (const raw of def.hosts) {
    const failure = ownerHostFailure(raw);
    if (failure) fail(failure);
  }
}

// A constant header may never collide with the credential header.
function checkHeaders(def: IntegrationDef, fail: (s: string) => void): void {
  const credentialHeader = def.auth.kind === 'bearer' || def.auth.kind === 'basic'
    ? 'authorization'
    : def.auth.kind === 'header' && def.auth.header
      ? def.auth.header.toLowerCase()
      : null;
  const check = (headers: Record<string, string> | undefined, at: string): void => {
    for (const name of Object.keys(headers ?? {})) {
      if (name === 'authorization' || name === credentialHeader) {
        fail(`${at}: the "${name}" header carries the credential - auth declares it, never a constant`);
      }
    }
  };
  check(def.headers, 'headers');
  for (const endpoint of def.endpoints) check(endpoint.headers, `endpoint "${endpoint.id}" headers`);
}

function benignParams(endpoint: IntegrationEndpointDef): IntegrationParams {
  const out: IntegrationParams = {};
  const slots = pathSlots(endpoint.path);
  for (const [name, decl] of Object.entries(endpoint.params)) {
    if (!decl.required && !slots.includes(name)) continue;
    if (decl.type === 'string') out[name] = decl.choices?.[0] ?? 'x';
    else if (decl.type === 'number') out[name] = 1;
    else out[name] = true;
  }
  return out;
}

// Path auth resolves with a stand-in secret; the real one exists only in the executor.
function standInPrefix(def: IntegrationDef): string | undefined {
  return def.auth.kind === 'path' ? def.auth.template.replace('{secret}', 'gate-stand-in-secret') : undefined;
}

function checkEndpoints(def: IntegrationDef, ownerHost: string | null, fail: (s: string) => void): void {
  const seen = new Set<string>();
  for (const endpoint of def.endpoints) {
    const at = `endpoint "${endpoint.id}"`;
    if (seen.has(endpoint.id)) fail(`${at} is declared twice`);
    seen.add(endpoint.id);

    if (METHOD_PREFIX_RE.test(endpoint.displayName) || endpoint.displayName.includes('/') || endpoint.displayName.includes('_')) {
      fail(`${at}: display name "${endpoint.displayName}" must be plain words, never a method or path`);
    }
    if (MACHINE_WORD_RE.test(endpoint.displayName)) {
      fail(`${at}: display name "${endpoint.displayName}" carries machine words - say what it does in plain words`);
    }
    if (endpoint.method === 'DELETE' && endpoint.class === 'read') {
      fail(`${at}: a DELETE that calls itself a read is the lie that matters`);
    }
    if (!endpoint.path.startsWith('/')) fail(`${at}: path must start with /`);
    if (endpoint.host && Array.isArray(def.hosts) && !def.hosts.includes(endpoint.host)) {
      fail(`${at}: host "${endpoint.host}" is not in the declared host list`);
    }
    for (const slot of pathSlots(endpoint.path)) {
      if (!/^[a-z][a-z0-9_]*$/.test(slot)) fail(`${at}: path slot "{${slot}}" is malformed`);
      else if (!(slot in endpoint.params)) fail(`${at}: path slot "{${slot}}" has no declared param`);
    }
    for (const [name, decl] of Object.entries(endpoint.params)) {
      if (decl.choices && decl.type !== 'string') fail(`${at}: param "${name}" declares choices but is not a string`);
    }

    // Every endpoint must resolve on its own host with plain values.
    const benign = benignParams(endpoint);
    const url = resolveIntegrationUrl(def, endpoint, benign, ownerHost, standInPrefix(def));
    if (url === null) {
      fail(`${at}: does not resolve against its own host with plain values`);
    }

    // Replay every attack string through every string param; the resolver must refuse or stay on-host.
    const expectedHost = url ? new URL(url).host : null;
    for (const name of Object.keys(endpoint.params)) {
      if (endpoint.params[name]?.type !== 'string') continue;
      for (const attack of ATTACK_STRINGS) {
        const probe = { ...benign, [name]: attack };
        const resolved = resolveIntegrationUrl(def, endpoint, probe, ownerHost, standInPrefix(def));
        if (resolved !== null && expectedHost !== null && new URL(resolved).host !== expectedHost) {
          fail(`${at}: param "${name}" lets a request escape the declared host`);
          break;
        }
      }
    }
  }
}

function checkFixtures(def: IntegrationDef, ownerHost: string | null, fail: (s: string) => void): void {
  for (const [i, fixture] of def.fixtures.entries()) {
    const endpoint = def.endpoints.find((e) => e.id === fixture.endpoint);
    if (!endpoint) {
      fail(`fixture ${i + 1} names unknown endpoint "${fixture.endpoint}"`);
      continue;
    }
    const verdict = validateIntegrationParams(endpoint, fixture.params);
    if (!verdict.ok) fail(`fixture ${i + 1} (${endpoint.id}): ${verdict.refusal}`);
    else if (resolveIntegrationUrl(def, endpoint, fixture.params, ownerHost, standInPrefix(def)) === null) {
      fail(`fixture ${i + 1} (${endpoint.id}): does not resolve on the declared host`);
    }
  }
}

// Run the whole gate over a candidate declaration; never throws, collects every failure.
export function gateIntegrationDef(candidate: unknown): GateResult {
  const parsed = integrationDefSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      failures: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'def'}: ${issue.message}`),
    };
  }
  const def = parsed.data;
  const failures: string[] = [];
  const fail = (s: string) => failures.push(s);

  checkHosts(def, fail);

  const leaves: string[] = [];
  stringLeaves(def, leaves);
  for (const leaf of leaves) {
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.test(leaf)) {
        fail('the declaration carries what looks like a live credential - defs name a vault secret, never hold one');
        break;
      }
    }
  }

  if (def.auth.kind !== 'none' && def.auth.kind === 'header' && !def.auth.header) {
    fail('header auth must name the header the secret rides');
  }
  if (def.auth.kind === 'oauth') {
    for (const [label, raw] of [['authUrl', def.auth.authUrl], ['tokenUrl', def.auth.tokenUrl]] as const) {
      try {
        if (new URL(raw).protocol !== 'https:') fail(`${label} must be https`);
      } catch {
        fail(`${label} is not a valid URL`);
      }
    }
  }
  if (def.auth.kind === 'body') {
    // Body auth needs a json-bodied write on every endpoint.
    for (const endpoint of def.endpoints) {
      const ridesJson = (endpoint.body ?? 'json') === 'json'
        && endpoint.method !== 'GET' && endpoint.method !== 'DELETE' && endpoint.body !== 'query';
      if (!ridesJson) fail(`endpoint "${endpoint.id}": body auth needs a json body on every endpoint`);
    }
  }

  // Sync may only pull: read-class endpoint with a mirror table to land in.
  if (def.sync) {
    const target = def.endpoints.find((e) => e.id === def.sync?.endpoint);
    if (!target) fail(`sync names unknown endpoint "${def.sync.endpoint}"`);
    else if (target.class !== 'read') fail(`sync endpoint "${def.sync.endpoint}" must be a read - a scheduled fire only pulls`);
    if (def.inside.tables.length === 0) fail('sync declares a mirror but no inside table lands it');
  }

  // Import doors may only read, and paging params must be declared endpoint params.
  if (def.importDoor) {
    const door = def.importDoor;
    const target = def.endpoints.find((e) => e.id === door.endpoint);
    if (!target) fail(`importDoor names unknown endpoint "${door.endpoint}"`);
    else {
      if (target.class !== 'read') fail(`importDoor endpoint "${door.endpoint}" must be a read - an import only pulls`);
      if (door.page && !(door.page.param in target.params)) {
        fail(`importDoor page param "${door.page.param}" is not declared on endpoint "${door.endpoint}"`);
      }
    }
  }

  checkHeaders(def, fail);

  // Owner-pinned/template defs gate against a stand-in host; the real one arrives at Connect.
  const ownerHost = Array.isArray(def.hosts)
    ? null
    : 'template' in def.hosts
      ? def.hosts.template.replace(`{${def.hosts.slot}}`, 'gatestand')
      : 'https://owner-pinned.example';
  checkEndpoints(def, ownerHost, fail);
  checkFixtures(def, ownerHost, fail);

  if (failures.length > 0) return { ok: false, failures: [...new Set(failures)] };
  return { ok: true, specHash: integrationSpecHash(def), def };
}
