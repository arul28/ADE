import { useEffect, useSyncExternalStore } from "react";
import type { CloudAccountState, CloudMachinesResult } from "../../shared/adeCloud";
import { useAdeCloudEnabled } from "./cloudAccess";

/**
 * The ADE Cloud account (plan, hours, disk, referral) for the always-on
 * surfaces: the header's meter, the sidebar invite pill, Settings › Account.
 *
 * Two writers keep it current:
 * - every read of the shared computer list (`useCloudMachines`, the dashboard
 *   and the composer) publishes its account here, so a plan change or a Free
 *   up space on the dashboard reaches the header at once;
 * - while nothing watches that list, this store reads it itself: once when the
 *   first surface subscribes, every 5 minutes, and when ADE Cloud says
 *   something changed. Never on focus or on a fast timer: the header is
 *   always on screen.
 *
 * Account level, so no pin. Only an account ADE Cloud lets in sees it; when
 * access turns off the account is dropped at once, and a read that was already
 * running when it did is ignored.
 */

const REFRESH_MS = 5 * 60_000;

let account: CloudAccountState | null = null;
let generation = 0;
let reading = false;
let readAgain = false;
/** The shared computer list is watched (and read on focus and cloud events): this store takes its account from it. */
let fed = false;
let timer: number | null = null;
let offStatus: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: CloudAccountState | null): void {
  if (next === account) return;
  account = next;
  for (const listener of listeners) listener();
}

function accountOf(result: CloudMachinesResult | null | undefined): CloudAccountState | null {
  return result?.state === "ok" ? result.account ?? null : null;
}

/** A read of the computer list answered (from `useCloudMachines`): its account is the newest. */
export function noteCloudAccountRead(result: CloudMachinesResult | null | undefined): void {
  publish(accountOf(result));
}

/** Whether the shared computer list is watched; while it is, this store does not read on its own. */
export function setCloudAccountFed(next: boolean): void {
  fed = next;
}

function read(): void {
  const list = typeof window === "undefined" ? undefined : window.ade?.cloud?.listMachines;
  if (!list || listeners.size === 0) return;
  if (reading) {
    readAgain = true;
    return;
  }
  reading = true;
  const current = generation;
  void list().then(
    (result) => {
      if (current === generation) publish(accountOf(result));
    },
    () => undefined,
  ).finally(() => {
    reading = false;
    // Something changed while this read ran: read once more for it.
    const again = readAgain && current === generation;
    readAgain = false;
    if (again) read();
  });
}

/** The timer and cloud events read only while the shared list isn't already doing it. */
function readUnlessFed(): void {
  if (!fed) read();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (!fed || account == null) read();
    timer = window.setInterval(readUnlessFed, REFRESH_MS);
    offStatus = window.ade?.cloud?.onStatusChanged?.(readUnlessFed) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer != null) window.clearInterval(timer);
    timer = null;
    offStatus?.();
    offStatus = null;
  };
}

/** Access turned off (sign-out, lost access): drop the account and any read still running. */
function forget(): void {
  generation += 1;
  readAgain = false;
  publish(null);
}

const snapshot = () => account;
const noop = () => () => undefined;
const none = () => null;

/** The account while ADE Cloud is on; null while off, or before the first read answers. */
export function useCloudAccount(): CloudAccountState | null {
  const enabled = useAdeCloudEnabled();
  const value = useSyncExternalStore(enabled ? subscribe : noop, enabled ? snapshot : none, none);
  useEffect(() => {
    if (!enabled) forget();
  }, [enabled]);
  return enabled ? value : null;
}
