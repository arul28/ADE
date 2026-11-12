import { useSyncExternalStore } from "react";
import type { CloudSignInEnd } from "../../shared/cloudSignIns";

/**
 * Whether ADE Cloud exists in this window: the server's yes for this account,
 * from this desktop's main process, or a connected machine's on the web.
 * Everything else is no, including "not known yet", so every surface starts
 * hidden. Read when a window opens or takes focus, and when the answer changes
 * (a sign-in, a sign-out, another computer's window). No timer: the answer
 * reaches the server at most once every 10 minutes (`cloudAccess.ts`).
 */

let enabled = false;
/** The end warning's pass, from the same read (desktop main fills it only while ADE Cloud is on). */
let signInEnd: CloudSignInEnd | null = null;
let reading = false;
let readAgain = false;
const listeners = new Set<() => void>();
let stopWatch: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function read(): void {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.cloudAccess;
  if (!bridge) return;
  if (reading) {
    readAgain = true;
    return;
  }
  reading = true;
  void bridge.read().then(
    (answer) => ({ on: answer?.enabled === true, end: answer?.enabled === true ? answer.signInEnd ?? null : null }),
    () => ({ on: false, end: null }),
  ).then((next) => {
    reading = false;
    const changed = next.on !== enabled || (next.end?.fingerprint ?? null) !== (signInEnd?.fingerprint ?? null)
      || (next.end?.endsInDays ?? null) !== (signInEnd?.endsInDays ?? null);
    enabled = next.on;
    // The same pass state keeps its object, so the warning does not render again for nothing.
    if (changed) signInEnd = next.end;
    if (changed) emit();
    if (readAgain) {
      readAgain = false;
      read();
    }
  });
}

function startWatch(): void {
  if (stopWatch || typeof window === "undefined") return;
  const onFocus = () => read();
  window.addEventListener("focus", onFocus);
  const offChanged = window.ade?.cloudAccess?.onChanged(read) ?? null;
  // A pass approved, renewed or removed in any window: the end warning reads again.
  const offSignIns = window.ade?.cloud?.onCloudSignInChanged?.(read) ?? null;
  stopWatch = () => {
    window.removeEventListener("focus", onFocus);
    offChanged?.();
    offSignIns?.();
    stopWatch = null;
  };
  read();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startWatch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatch?.();
  };
}

function snapshot(): boolean {
  return enabled;
}

function signInEndSnapshot(): CloudSignInEnd | null {
  return signInEnd;
}

/** The sign-in the end warning names (a Claude pass or a key), or null (always null while ADE Cloud is off). */
export function useCloudSignInEnd(): CloudSignInEnd | null {
  return useSyncExternalStore(subscribe, signInEndSnapshot, signInEndSnapshot);
}

/** The hook every ADE Cloud surface sits behind. */
export function useAdeCloudEnabled(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** For code outside a component that has to act when the answer changes. */
export const subscribeAdeCloudAccess = subscribe;

/** For code outside a component (settings search, one-shot reads). Starts the watch if nothing has. */
export function adeCloudEnabled(): boolean {
  startWatch();
  return enabled;
}
