import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Envelope encryption: each secret gets its own AES-256-GCM data key, wrapped by a master key held only in server memory.
// Pure crypto: the master key arrives as an argument; no env reads, no storage, no logging.
// Wire shape: v1.<wrapIv>.<wrappedKey+tag>.<dataIv>.<ciphertext+tag>

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class EnvelopeError extends Error {}

function assertMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new EnvelopeError(`the master key must be ${KEY_BYTES} bytes (got ${masterKey.length})`);
  }
}

function gcmSeal(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

function gcmOpen(key: Buffer, iv: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < 16) throw new EnvelopeError('sealed payload too short');
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // One named sentence, never the crypto library's internals.
    throw new EnvelopeError('the sealed secret does not open - wrong master key or tampered ciphertext');
  }
}

/** Seals a plaintext value under a fresh per-secret data key wrapped by the master key. */
export function sealEnvelope(masterKey: Buffer, plaintext: string): string {
  assertMasterKey(masterKey);
  const dataKey = randomBytes(KEY_BYTES);
  const wrapIv = randomBytes(IV_BYTES);
  const dataIv = randomBytes(IV_BYTES);
  const wrappedKey = gcmSeal(masterKey, wrapIv, dataKey);
  const ct = gcmSeal(dataKey, dataIv, Buffer.from(plaintext, 'utf8'));
  return [VERSION, wrapIv.toString('base64'), wrappedKey.toString('base64'), dataIv.toString('base64'), ct.toString('base64')].join('.');
}

/** Opens a sealed envelope. Throws the ONE named sentence on any tamper/wrong key. */
export function openEnvelope(masterKey: Buffer, sealed: string): string {
  assertMasterKey(masterKey);
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new EnvelopeError('the sealed secret is not a recognized envelope');
  }
  const [, wrapIvB64, wrappedKeyB64, dataIvB64, ctB64] = parts;
  const dataKey = gcmOpen(masterKey, Buffer.from(wrapIvB64!, 'base64'), Buffer.from(wrappedKeyB64!, 'base64'));
  if (dataKey.length !== KEY_BYTES) throw new EnvelopeError('the sealed secret does not open - wrong master key or tampered ciphertext');
  return gcmOpen(dataKey, Buffer.from(dataIvB64!, 'base64'), Buffer.from(ctB64!, 'base64')).toString('utf8');
}

/** Parses the host-provided master key material (64 hex chars or 44-char base64). */
export function parseMasterKey(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === KEY_BYTES) return b64;
  throw new EnvelopeError('the master key material must be 32 bytes (64 hex chars or base64)');
}
