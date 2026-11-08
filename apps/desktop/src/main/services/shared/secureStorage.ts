import type { SafeStorage } from "electron";

/** Electron's Linux basic_text backend uses a fixed key, not a secret store. */
export function isSecureStorageAvailable(storage: SafeStorage | null | undefined): boolean {
  try {
    return Boolean(storage?.isEncryptionAvailable())
      && (process.platform !== "linux" || storage?.getSelectedStorageBackend() !== "basic_text");
  } catch {
    return false;
  }
}
