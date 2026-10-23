// Workspace wire codec: swaps ArrayBuffers for tagged base64 envelopes across JSON transport. Pure, environment-free.

const WIRE_TAG = 'workspace/bytes-b64';

export interface WireBytesEnvelope {
  __wire: typeof WIRE_TAG;
  b64: string;
}

export function isWireBytesEnvelope(value: unknown): value is WireBytesEnvelope {
  return (
    typeof value === 'object' && value !== null &&
    (value as { __wire?: unknown }).__wire === WIRE_TAG &&
    typeof (value as { b64?: unknown }).b64 === 'string'
  );
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64_ALPHABET[b0 >> 2]! + B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63]! : '=';
  }
  return out;
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let accBits = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v === -1) throw new Error('workspace wire: malformed base64 payload');
    acc = (acc << 6) | v;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[n++] = (acc >> accBits) & 0xff;
    }
  }
  return out.buffer;
}

/** Door-side: swaps every ArrayBuffer in the tree for the tagged envelope; returns the input untouched when no bytes exist. */
export function encodeWorkspaceWire(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { __wire: WIRE_TAG, b64: bytesToBase64(value) } satisfies WireBytesEnvelope;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const enc = encodeWorkspaceWire(v);
      if (enc !== v) changed = true;
      return enc;
    });
    return changed ? next : value;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const enc = encodeWorkspaceWire(v);
      if (enc !== v) changed = true;
      next[k] = enc;
    }
    return changed ? next : value;
  }
  return value;
}

/** Client-side: the exact inverse — tagged envelopes become ArrayBuffers again. */
export function decodeWorkspaceWire(value: unknown): unknown {
  if (isWireBytesEnvelope(value)) return base64ToBytes(value.b64);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const dec = decodeWorkspaceWire(v);
      if (dec !== v) changed = true;
      return dec;
    });
    return changed ? next : value;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const dec = decodeWorkspaceWire(v);
      if (dec !== v) changed = true;
      next[k] = dec;
    }
    return changed ? next : value;
  }
  return value;
}
