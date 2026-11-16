/**
 * Every computer with a copy of the open repository joins its tab.
 *
 * A tab is one project, and it shows the work of every computer of the
 * account that has a copy (lanes, chats, terminals). The union read
 * (`crossMachineLanes.ts`) reads only connected computers, so when a
 * repository tab is in front this connects, in the background, each copy's
 * computer that the account lists as online and that this window has no live
 * connection to. Nothing here moves the tab: the tab's own copy stays where it
 * is, and the connect never makes another computer the one on screen.
 *
 * - The person's choices win: a computer they disconnected, or set not to
 *   reconnect on its own, answers `declined` and stays off
 *   (`MachineConnectOptions.background`).
 * - A sleeping ADE Cloud computer is not online, so it is not woken here;
 *   opening one of its lanes wakes it.
 * - ADE Web holds at most `WEB_MACHINE_SESSION_LIMIT` connections; a
 *   background connect never parks another computer for room. A computer
 *   left out for room is tried again every `RETRY_BASE_MS`, so it joins soon
 *   after any connection closes, also one of another project.
 * - A pass runs when the tab or the set of unconnected copies changes, when
 *   the window gets focus, and when the page becomes visible again. Such a
 *   pass tries a computer again before its backoff ends, at most once per
 *   `RETRY_BASE_MS`.
 * - A computer that did not join is tried again on a local timer, for as long
 *   as the page is visible: after `RETRY_BASE_MS`, then twice as long after
 *   each failure in a row, up to `RETRY_MAX_MS`. That covers a computer that
 *   is off for an hour as well as one that dropped for a minute. A computer
 *   the account lists as off or asleep counts as a failure: it is checked
 *   again on the same schedule, and it is never dialed. The timer makes no
 *   call while nothing is due, and none while the page is hidden.
 */
import { useEffect } from "react";
import { forwardSignalToSentry } from "../../shared/sentry/logBridge";
import { sameMachineKey } from "../../shared/machineAddress";
import { isAdeAvailable } from "../lib/adeAvailability";
import { fetchAccountMachines } from "../lib/account";
import { isPageHidden } from "../lib/pageVisibility";
import type { RepositoryCopy } from "../../shared/repositoryTab";
import type { AdeAccountMachine } from "../../shared/types";
import { resolveMachinePresence, type MachinePresence } from "../../shared/types/power";
import { useVisibleRepositoryTab } from "./repositoryScope";
import { useRepositoryCopies } from "./useRepositoryCopies";

/** The first retry of a computer that did not join (offline, unreachable); each failure in a row doubles it. */
const RETRY_BASE_MS = 15_000;
/** The longest wait between two tries of one computer. */
const RETRY_MAX_MS = 60_000;

type RetryState = {
  /** Failed tries in a row (a computer the account lists as off counts). */
  failures: number;
  /** The timer does not try it again before this time. */
  nextAt: number;
  /** The last try; a focus or a change tries again once `RETRY_BASE_MS` passed since. */
  triedAt: number;
  /**
   * The person's Disconnect (or "don't reconnect"): the timer leaves it alone,
   * and only the next change or focus asks again.
   */
  declined: boolean;
};

const retryByMachineKey = new Map<string, RetryState>();
let running: Promise<void> | null = null;
let queued: { machineKeys: readonly string[]; fromTimer: boolean } | null = null;

function noteFailure(key: string, now: number): void {
  const failures = (retryByMachineKey.get(key)?.failures ?? 0) + 1;
  const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
  retryByMachineKey.set(key, { failures, nextAt: now + wait, triedAt: now, declined: false });
}

function isDue(key: string, now: number, fromTimer: boolean): boolean {
  const retry = retryByMachineKey.get(key);
  if (!retry) return true;
  if (retry.declined) return !fromTimer;
  if (retry.nextAt <= now) return true;
  // The person is back (focus, a shown page) or the set changed: try sooner
  // than the backoff, but not more than once per RETRY_BASE_MS.
  return !fromTimer && now - retry.triedAt >= RETRY_BASE_MS;
}

async function connectInBackground(machineKeys: readonly string[], fromTimer: boolean): Promise<void> {
  const connect = window.ade?.machines?.connect;
  if (!isAdeAvailable(connect)) return;
  // A hidden page dials nothing; it passes again when it is shown.
  if (isPageHidden()) return;
  const now = Date.now();
  const due = machineKeys.map((key) => key.toLowerCase()).filter((key) => isDue(key, now, fromTimer));
  if (due.length === 0) return;
  // Awake per the account: a computer that is off is not dialed, and neither
  // is a cloud computer that went to sleep while its heartbeat still reads
  // online (the sleep state says so first).
  const machines = await fetchAccountMachines();
  if (machines.state !== "ok") {
    // Signed out or no account: nothing to retry until that changes. A failed
    // read is tried again like a computer.
    if (machines.state === "unavailable" || machines.state === "cancelled") {
      for (const key of due) noteFailure(key, Date.now());
    }
    return;
  }
  for (const key of due) {
    // Hidden during the read or an earlier dial: stop here. The rest stay due
    // and the pass runs again when the page is shown.
    if (isPageHidden()) return;
    const row = machines.machines.find((machine) => sameMachineKey(machine.machineKey, key));
    if (accountMachinePresence(row) !== "online") {
      // Off or asleep: look again later, and never wake it from here.
      noteFailure(key, Date.now());
      continue;
    }
    const result = await connect(key, { background: true }).catch((error: unknown) => ({
      ok: false as const,
      reason: "unreachable" as const,
      machineKey: key,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (result.ok) {
      retryByMachineKey.delete(key);
      continue;
    }
    if (result.reason === "declined") {
      retryByMachineKey.set(key, { failures: 0, nextAt: 0, triedAt: Date.now(), declined: true });
      continue;
    }
    if (result.reason === "no_room") {
      // Nothing is wrong with it: look again on the next tick, without backoff.
      const at = Date.now();
      retryByMachineKey.set(key, { failures: 0, nextAt: at + RETRY_BASE_MS, triedAt: at, declined: false });
      continue;
    }
    noteFailure(key, Date.now());
    // Once per computer while it stays down, not once per try.
    if ((retryByMachineKey.get(key)?.failures ?? 0) === 1) {
      forwardSignalToSentry("repository.copy_connect_failed", { reason: result.reason }, `copy_connect_failed:${result.reason}`, "info");
    }
  }
}

/**
 * Whether the account's row says the computer is awake, asleep or off, with
 * no connection from here counted (the copies in question have none).
 */
export function accountMachinePresence(machine: AdeAccountMachine | undefined): MachinePresence | null {
  if (!machine) return null;
  return resolveMachinePresence({
    connected: false,
    online: machine.online,
    sleepState: machine.sleepState,
    sleepStateAt: machine.sleepStateAt,
    lastSeenAt: machine.lastSeenAt,
  });
}

/**
 * The machine keys of copies on other computers that this window has no live
 * connection to, unique and sorted, one per line: a stable effect key.
 */
export function unconnectedCopyMachineKeys(copies: readonly RepositoryCopy[]): string {
  const keys = new Map<string, string>();
  for (const copy of copies) {
    if (copy.isThisMachine || copy.online || !copy.machineKey) continue;
    keys.set(copy.machineKey.toLowerCase(), copy.machineKey);
  }
  return [...keys.values()].sort().join("\n");
}

/** Runs one pass at a time; a newer set waits for the pass in flight, older queued sets are dropped. */
function schedule(machineKeys: readonly string[], fromTimer: boolean): void {
  if (running) {
    // A change or focus waiting behind the pass in flight keeps its weight.
    queued = { machineKeys, fromTimer: fromTimer && (queued?.fromTimer ?? true) };
    return;
  }
  running = connectInBackground(machineKeys, fromTimer).finally(() => {
    running = null;
    const next = queued;
    queued = null;
    if (next) schedule(next.machineKeys, next.fromTimer);
  });
}

/**
 * Keeps every online computer with a copy of the tab's repository connected
 * while the tab is in front (desktop and ADE Web), also a no-machine tab whose
 * copies are all on computers that are not connected. Mount once per window.
 */
export function useConnectRepositoryCopies(): void {
  const tab = useVisibleRepositoryTab();
  const copies = useRepositoryCopies(tab, tab?.kind === "account");
  const keys = unconnectedCopyMachineKeys(copies);
  useEffect(() => {
    if (!keys) {
      retryByMachineKey.clear();
      return;
    }
    const machineKeys = keys.split("\n");
    // A computer that joined, or whose copy left, starts fresh next time.
    const present = new Set(machineKeys.map((key) => key.toLowerCase()));
    for (const key of [...retryByMachineKey.keys()]) if (!present.has(key)) retryByMachineKey.delete(key);
    const pass = () => schedule(machineKeys, false);
    const onVisibility = () => {
      if (!isPageHidden()) pass();
    };
    pass();
    window.addEventListener("focus", pass);
    document.addEventListener("visibilitychange", onVisibility);
    // Checks every RETRY_BASE_MS; a tick calls nothing unless a computer is due.
    const retry = window.setInterval(() => {
      const now = Date.now();
      if (isPageHidden() || !machineKeys.some((key) => isDue(key.toLowerCase(), now, true))) return;
      schedule(machineKeys, true);
    }, RETRY_BASE_MS);
    return () => {
      window.removeEventListener("focus", pass);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(retry);
    };
  }, [keys]);
}
