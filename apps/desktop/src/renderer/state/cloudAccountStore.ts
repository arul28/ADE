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
 * - this store reads the list itself once when the first surface subscribes
 *   (unless the shared list already gave an account), whenever the last answer
 *   from either writer is 5 minutes old, and on ADE Cloud's change events
 *   while nothing watches the shared list (which reads on them itself). At
 *   most one read per 5 minutes from the timer; never on focus.
 *
 * Losing access (`not_connected`, `access_refused`) drops the account; a blip
 * (`unreachable`, an answer without plan and hours) keeps the last one.
 *
 * Account level, so no pin. Only an account ADE Cloud lets in sees it; when
 * access turns off the account is dropped at once, and a read that was already
 * running when it did is ignored.
 */

const REFRESH_MS = 5 * 60_000;
/** How often the timer looks at the age of the last answer (a comparison, not a read). */
const CHECK_MS = 60_000;

let account: CloudAccountState | null = null;
/** When a list read last answered, from either writer: the timer reads only once this is 5 minutes old. */
let lastAccountAt = 0;
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

/**
 * Take one answer of the list. No access (`not_connected`, `access_refused`)
 * drops the account; a blip (`unreachable`, or `ok` without plan and hours)
 * keeps the last one, as the shared list keeps its last answer while a
 * refresh runs.
 */
function take(result: CloudMachinesResult | null | undefined): void {
  lastAccountAt = Date.now();
  if (!result) return;
  if (result.state === "not_connected" || result.state === "access_refused") publish(null);
  else if (result.state === "ok" && result.account) publish(result.account);
}

/** A read of the computer list answered (from `useCloudMachines`): its account is the newest. */
export function noteCloudAccountRead(result: CloudMachinesResult | null | undefined): void {
  take(result);
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
      if (current === generation) take(result);
    },
    () => {
      // A failed call still counts as this period's read: the next try is in 5 minutes.
      lastAccountAt = Date.now();
    },
  ).finally(() => {
    reading = false;
    // Something changed while this read ran: read once more for it.
    const again = readAgain && current === generation;
    readAgain = false;
    if (again) read();
  });
}

/** Cloud events read only while the shared list isn't already reading on them. */
function readUnlessFed(): void {
  if (!fed) read();
}

/** At most one list read per 5 minutes, from either writer, fed or not. */
function readIfOld(): void {
  if (Date.now() - lastAccountAt >= REFRESH_MS) read();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (!fed || account == null) read();
    timer = window.setInterval(readIfOld, CHECK_MS);
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
