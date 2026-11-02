import { READABLE_TOAST_DURATION_MS, showToast } from "../components/app/toast/toastStore";
import { describeHostStall, describeHostStorageWait } from "../../shared/connectionDiagnosis";
import type { RemoteRuntimeHostStall, RemoteRuntimeHostStorageWait } from "../../shared/types";

/** Older than this, a freeze no longer explains the reconnect just seen. */
const ANNOUNCE_WINDOW_MS = 5 * 60_000;
const announced = new Set<string>();

/**
 * "Studio froze for 12s. Its CPU is overloaded (load 21 on 8 cores)." once per
 * freeze, when a machine is reached again and says it froze. Without it the
 * reconnect read as this device's network failing.
 *
 * A freeze is an event, so it is a toast (see docs/design/notices.md); the
 * machine row keeps a quiet note for the next few minutes.
 */
export function announceHostStall(args: {
  stall: RemoteRuntimeHostStall | null | undefined;
  machineKey: string | null | undefined;
  machineName: string | null | undefined;
  now?: number;
}): void {
  const { stall } = args;
  if (!stall || !args.machineKey) return;
  const now = args.now ?? Date.now();
  if (now - stall.endedAt > ANNOUNCE_WINDOW_MS) return;
  // The age travels rounded through two clocks; 30 s buckets keep one freeze
  // one toast across the reconnects that follow it.
  const key = `${args.machineKey}:${Math.round(stall.endedAt / 30_000)}`;
  if (announced.has(key)) return;
  announced.add(key);
  if (announced.size > 64) announced.delete(announced.values().next().value as string);
  const summary = describeHostStall(stall, args.machineName);
  showToast({
    id: `host-stall:${args.machineKey}`,
    tone: "warning",
    title: summary.title,
    message: summary.detail,
    durationMs: READABLE_TOAST_DURATION_MS,
  });
}

const announcedWaits = new Set<string>();

/**
 * "Studio is waiting for permission" once per wait, when a machine says one of
 * its project folders stopped answering. The person who can click Allow may be
 * at this device, not that one; the machine row keeps the note until it clears.
 */
export function announceHostStorageWait(args: {
  wait: RemoteRuntimeHostStorageWait | null | undefined;
  machineKey: string | null | undefined;
  machineName: string | null | undefined;
}): void {
  const { wait } = args;
  if (!wait || !args.machineKey) return;
  // The start travels as an age through two clocks; 30 s buckets keep one wait one toast.
  const key = `${args.machineKey}:${wait.reason}:${wait.path}:${Math.round(wait.since / 30_000)}`;
  if (announcedWaits.has(key)) return;
  announcedWaits.add(key);
  if (announcedWaits.size > 64) announcedWaits.delete(announcedWaits.values().next().value as string);
  const summary = describeHostStorageWait(wait, args.machineName);
  showToast({
    id: `host-storage-wait:${args.machineKey}`,
    tone: "warning",
    title: summary.title,
    message: summary.detail,
    durationMs: READABLE_TOAST_DURATION_MS,
  });
}
