import type { SafeStorage } from "electron";

/**
 * The OS credential store's first answer, asked off the main thread.
 *
 * safeStorage's synchronous calls read the app's key on the calling thread. On
 * macOS a build the Keychain does not trust gets a prompt there, and the main
 * process then answers nothing (no IPC, no window work) until the person
 * clicks. `safeStorage.isAsyncEncryptionAvailable()` sets the key up off the
 * main thread instead. Until it answers, nothing here makes a synchronous call:
 * secure storage reads as "not yet", and the stores that need it wait for
 * `onSecureStorageAnswered`. A "no" (Deny, no keyring) is kept for the life of
 * the process, so the main thread never asks again.
 */
type SecureStorageCheck =
  | { state: "not_started" }
  | { state: "pending" }
  /** `available` null: the asynchronous check failed, so the synchronous call decides. */
  | { state: "answered"; available: boolean | null };

let check: SecureStorageCheck = { state: "not_started" };
const answeredListeners = new Set<() => void>();

/** Starts the check once, after the app is ready. Never blocks. */
export function startSecureStorageCheck(storage: SafeStorage | null | undefined): void {
  if (check.state !== "not_started") return;
  const ask = storage?.isAsyncEncryptionAvailable;
  if (typeof ask !== "function") {
    check = { state: "answered", available: null };
    return;
  }
  check = { state: "pending" };
  const settle = (available: boolean | null): void => {
    check = { state: "answered", available };
    for (const listener of Array.from(answeredListeners)) {
      try {
        listener();
      } catch {
        // One store's refresh must not stop the others.
      }
    }
  };
  let answer: Promise<boolean>;
  try {
    answer = Promise.resolve(ask.call(storage));
  } catch {
    settle(null);
    return;
  }
  answer.then((available) => settle(available === true), () => settle(null));
}

/** True while the OS credential store has not answered the first check. */
export function isSecureStorageCheckPending(): boolean {
  return check.state === "pending";
}

/** Called once, when the first check answers. Returns an unsubscribe. */
export function onSecureStorageAnswered(listener: () => void): () => void {
  answeredListeners.add(listener);
  return () => {
    answeredListeners.delete(listener);
  };
}

/**
 * Whether safeStorage can seal and open secrets now. False while the first
 * check is pending and after it said no, so this never makes the synchronous
 * call that can hold the main thread on a prompt.
 *
 * Electron's Linux basic_text backend uses a fixed key, not a secret store.
 */
export function isSecureStorageAvailable(storage: SafeStorage | null | undefined): boolean {
  if (check.state === "pending") return false;
  if (check.state === "answered" && check.available === false) return false;
  try {
    return Boolean(storage?.isEncryptionAvailable())
      && (process.platform !== "linux" || storage?.getSelectedStorageBackend?.() !== "basic_text");
  } catch {
    return false;
  }
}
