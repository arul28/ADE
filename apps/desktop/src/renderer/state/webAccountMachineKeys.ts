/**
 * ADE Web names a connection by its browser environment id and does not know
 * the account machine key behind it. The web workspace publishes the pairs
 * here, so a copy from the account list and a folder from a live connection on
 * the same computer join as one computer (the same count as the desktop).
 *
 * No imports on purpose: the web shell loads this before sign-in.
 */
let current: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

function sameKeyMap(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

/** ADE Web: environment id → account machine key, for every connection the browser knows. */
export function publishWebAccountMachineKeys(next: ReadonlyMap<string, string>): void {
  if (sameKeyMap(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeWebAccountMachineKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readWebAccountMachineKeys(): ReadonlyMap<string, string> {
  return current;
}
