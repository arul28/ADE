import { useSyncExternalStore } from "react";

/**
 * The computer a project open is waking first (ADE Web opening a project on
 * a sleeping ADE Cloud computer), or null. The top bar says "Waking …" for
 * the open instead of "Switching to project…".
 */
let waking: string | null = null;
const listeners = new Set<() => void>();

export function setProjectOpenWaking(name: string | null): void {
  if (waking === name) return;
  waking = name;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): string | null => waking;

export function useProjectOpenWaking(): string | null {
  return useSyncExternalStore(subscribe, read, read);
}
