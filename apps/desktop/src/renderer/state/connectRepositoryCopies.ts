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
 * - One attempt per computer per `RETRY_AFTER_MS`, one at a time. No timer:
 *   it runs again only when the tab or the set of unconnected copies changes.
 */
import { useEffect } from "react";
import { forwardSignalToSentry } from "../../shared/sentry/logBridge";
import { sameMachineKey } from "../../shared/machineAddress";
import { isAdeAvailable } from "../lib/adeAvailability";
import { fetchAccountMachines } from "../lib/account";
import { useActiveRepositoryTab } from "./repositoryScope";
import { useRepositoryCopies } from "./useRepositoryCopies";

/** A computer that did not join (offline after all, unreachable) is tried again after this long. */
const RETRY_AFTER_MS = 60_000;

const attemptedAtByMachineKey = new Map<string, number>();
let running: Promise<void> | null = null;
let queued: readonly string[] | null = null;

async function connectInBackground(machineKeys: readonly string[]): Promise<void> {
  const connect = window.ade?.machines?.connect;
  if (!isAdeAvailable(connect)) return;
  const now = Date.now();
  const due = machineKeys.filter((key) => now - (attemptedAtByMachineKey.get(key.toLowerCase()) ?? 0) >= RETRY_AFTER_MS);
  if (due.length === 0) return;
  // Online per the account: a computer that is off or asleep is not dialed.
  const machines = await fetchAccountMachines().catch(() => null);
  if (!machines || machines.state !== "ok") return;
  for (const key of due) {
    const row = machines.machines.find((machine) => sameMachineKey(machine.machineKey, key));
    if (!row?.online) continue;
    attemptedAtByMachineKey.set(key.toLowerCase(), Date.now());
    const result = await connect(key, { background: true }).catch((error: unknown) => ({
      ok: false as const,
      reason: "unreachable" as const,
      machineKey: key,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!result.ok && result.reason !== "declined") {
      forwardSignalToSentry("repository.copy_connect_failed", { reason: result.reason }, `copy_connect_failed:${result.reason}`, "info");
    }
  }
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
  const keys = [...new Set(
    copies
      .filter((copy) => !copy.isThisMachine && !copy.online && copy.machineKey)
      .map((copy) => copy.machineKey as string),
  )].sort().join("\n");
  useEffect(() => {
    if (!keys) return;
    schedule(keys.split("\n"));
  }, [keys]);
}
