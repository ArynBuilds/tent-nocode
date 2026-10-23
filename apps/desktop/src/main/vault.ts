import { safeStorage } from 'electron';

// OS-keychain seal for this install's host secrets; secret values live in the local server's vault.

/** True when the OS keychain is available; false on a headless/misconfigured host. Callers must
 * refuse to store a secret when this is false rather than fall back to plaintext. */
export function vaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** Encrypt a plaintext secret to base64 ciphertext for storage. Throws if the keychain is down. */
export function sealSecret(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('secret storage unavailable: the OS keychain is not accessible');
  }
  return safeStorage.encryptString(plaintext).toString('base64');
}

/** Recover a plaintext secret from base64 ciphertext. Main-process only. */
export function openSecret(ciphertextB64: string): string {
  return safeStorage.decryptString(Buffer.from(ciphertextB64, 'base64'));
}
