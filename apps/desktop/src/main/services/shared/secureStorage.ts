import type { SafeStorage } from "electron";

/**
 * Whether a file ADE already saved can be read. Electron's Linux basic_text
 * backend qualifies, so an existing secret is migrated rather than stranded.
 */
export function canDecryptStoredSecrets(storage: SafeStorage | null | undefined): boolean {
  try {
    return Boolean(storage?.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/**
 * Whether a new secret may be written. Electron's Linux basic_text backend uses
 * a fixed key, not a secret store, so it does not count.
 */
export function isSecureStorageAvailable(storage: SafeStorage | null | undefined): boolean {
  try {
    return Boolean(storage?.isEncryptionAvailable())
      && (process.platform !== "linux" || storage?.getSelectedStorageBackend() !== "basic_text");
  } catch {
    return false;
  }
}
