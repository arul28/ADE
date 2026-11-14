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
 *   background connect never parks another computer for room.
 * - One attempt per computer per `RETRY_AFTER_MS`, one at a time. A pass runs
 *   when the tab or the set of unconnected copies changes, and on window
 *   focus (a computer started since then is online by now).
 * - A computer the account lists as online that did not answer is tried again
 *   on a local timer, up to `TIMED_RETRIES` times; the timer makes no call
 *   while nothing is due. A computer that is off is not polled: focus finds it.
 */
import { useEffect } from "react";
import { forwardSignalToSentry } from "../../shared/sentry/logBridge";
import { sameMachineKey } from "../../shared/machineAddress";
import { isAdeAvailable } from "../lib/adeAvailability";
import { fetchAccountMachines } from "../lib/account";
import type { RepositoryCopy } from "../../shared/repositoryTab";
import type { AdeAccountMachine } from "../../shared/types";
import { resolveMachinePresence, type MachinePresence } from "../../shared/types/power";
import { useActiveRepositoryTab } from "./repositoryScope";
import { useRepositoryCopies } from "./useRepositoryCopies";

/** A computer that did not join (offline after all, unreachable) is tried again after this long. */
const RETRY_AFTER_MS = 60_000;
/** Timed retries for a computer that is online but did not answer; after that, focus or a change retries it. */
const TIMED_RETRIES = 5;

const attemptedAtByMachineKey = new Map<string, number>();
/** Failed attempts in a row, for computers the account listed as online. */
const failuresByMachineKey = new Map<string, number>();
/** Failed reads of the account's computers in a row; the timer retries them like a computer. */
let directoryFailures = 0;
let running: Promise<void> | null = null;
let queued: readonly string[] | null = null;

async function connectInBackground(machineKeys: readonly string[]): Promise<void> {
  const connect = window.ade?.machines?.connect;
  if (!isAdeAvailable(connect)) return;
  const now = Date.now();
  const due = machineKeys.filter((key) => now - (attemptedAtByMachineKey.get(key.toLowerCase()) ?? 0) >= RETRY_AFTER_MS);
  if (due.length === 0) return;
  // Awake per the account: a computer that is off is not dialed, and neither
  // is a cloud computer that went to sleep while its heartbeat still reads
  // online (the sleep state says so first).
  const machines = await fetchAccountMachines();
  if (machines.state !== "ok") {
    // Signed out or no account: nothing to retry until that changes.
    if (machines.state === "unavailable" || machines.state === "cancelled") directoryFailures += 1;
    return;
  }
  directoryFailures = 0;
  for (const key of due) {
    const row = machines.machines.find((machine) => sameMachineKey(machine.machineKey, key));
    if (accountMachinePresence(row) !== "online") continue;
    attemptedAtByMachineKey.set(key.toLowerCase(), Date.now());
    const result = await connect(key, { background: true }).catch((error: unknown) => ({
      ok: false as const,
      reason: "unreachable" as const,
      machineKey: key,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (result.ok || result.reason === "declined") {
      failuresByMachineKey.delete(key.toLowerCase());
      // Declined (no room, or the person's Disconnect) asked nothing of the
      // machine: the next change, such as a freed slot, may try it at once.
      if (!result.ok) attemptedAtByMachineKey.delete(key.toLowerCase());
      continue;
    }
    failuresByMachineKey.set(key.toLowerCase(), (failuresByMachineKey.get(key.toLowerCase()) ?? 0) + 1);
    forwardSignalToSentry("repository.copy_connect_failed", { reason: result.reason }, `copy_connect_failed:${result.reason}`, "info");
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
function schedule(machineKeys: readonly string[]): void {
  if (running) {
    queued = machineKeys;
    return;
  }
  running = connectInBackground(machineKeys).finally(() => {
    running = null;
    const next = queued;
    queued = null;
    if (next) schedule(next);
  });
}

/**
 * Keeps every online computer with a copy of the tab's repository connected
 * while the tab is in front (desktop and ADE Web). Mount once per window.
 */
export function useConnectRepositoryCopies(): void {
  const tab = useActiveRepositoryTab();
  const copies = useRepositoryCopies(tab, tab?.kind === "account");
  const keys = unconnectedCopyMachineKeys(copies);
  useEffect(() => {
    if (!keys) return;
    const machineKeys = keys.split("\n");
    const pass = () => schedule(machineKeys);
    pass();
    window.addEventListener("focus", pass);
    const retry = window.setInterval(() => {
      const retryable = (failures: number) => failures > 0 && failures <= TIMED_RETRIES;
      const due = retryable(directoryFailures)
        || machineKeys.some((key) => retryable(failuresByMachineKey.get(key.toLowerCase()) ?? 0));
      if (due) pass();
      // A second past the retry gap, so a tick never lands just short of it.
    }, RETRY_AFTER_MS + 1_000);
    return () => {
      window.removeEventListener("focus", pass);
      window.clearInterval(retry);
    };
  }, [keys]);
}
