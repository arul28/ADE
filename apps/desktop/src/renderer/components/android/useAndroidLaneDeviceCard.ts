import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidLaneDeviceStatus } from "../../../shared/types/androidEmulator";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { androidLaneDeviceName } from "./androidDeviceState";

/**
 * The tools grid card's one fact about the Android tool: which emulator this
 * lane holds, and whether it is up. The Apple card's twin
 * (`useAppleLaneDeviceCard`).
 *
 * One status read when the card can show, then one again after each Android
 * event for the lane (a start, a stop, an attach or release from the pane,
 * the CLI or an agent). No poll: the brain emits on every lifecycle change,
 * and the hosted web client turns its own status poll into the same events.
 *
 * Every reader shares one store: the tools grid card, the Work corner card
 * and the running pill of each chat pane. There is one status read per lane
 * on a machine, and one event subscription per machine, keyed on the pin key.
 * A reader that mounts later gets the last reading and starts no read. The
 * store drops a lane when its last reader unmounts, and a machine when its
 * last lane goes.
 */

/** Events come in bursts (starting, then booted); one read after the burst. */
const EVENT_READ_DELAY_MS = 400;

export type AndroidLaneDeviceCard = {
  /** The lane this reading belongs to. */
  laneId: string;
  name: string;
  state: Exclude<AndroidLaneDeviceStatus["state"], "none">;
  /** The AVD folder name, for the card menu. */
  avdName: string;
  /** `created` = ADE made it for this lane (Delete removes it); `attached` = the user's own AVD. */
  origin: "created" | "attached";
};

type CardEntry = {
  laneId: string;
  machine: MachineEntry;
  card: AndroidLaneDeviceCard | null;
  /** The last read failed: the next reader to join reads again. */
  failed: boolean;
  /** The newest read started: an older answer that comes back later is dropped. */
  readSeq: number;
  readers: Set<() => void>;
  timer: number | null;
};

type MachineEntry = {
  key: string;
  /** The pin of the reader that opened the machine. A pin with the same key goes to the same machine. */
  pin: OpenProjectBinding | null;
  lanes: Map<string, CardEntry>;
  unsubscribe: (() => void) | null;
};

const machines = new Map<string, MachineEntry>();

function emitCard(entry: CardEntry): void {
  for (const reader of [...entry.readers]) reader();
}

function liveEntry(entry: CardEntry): boolean {
  return entry.machine.lanes.get(entry.laneId) === entry && machines.get(entry.machine.key) === entry.machine;
}

async function readCard(entry: CardEntry): Promise<void> {
  const api = window.ade?.androidEmulator;
  if (!api?.getStatus) return;
  const { laneId } = entry;
  const seq = ++entry.readSeq;
  let status: Awaited<ReturnType<typeof api.getStatus>>;
  try {
    status = await api.getStatus({ laneId }, entry.machine.pin);
  } catch (cause: unknown) {
    if (seq !== entry.readSeq) return;
    // A failed read is not "no device": the card keeps what it last read.
    entry.failed = true;
    logRendererDebugEvent("android.card_status_failed", { error: cause instanceof Error ? cause.message : String(cause) });
    return;
  }
  if (!liveEntry(entry) || seq !== entry.readSeq) return;
  entry.failed = false;
  const lane = status.lane;
  entry.card = lane?.device && lane.state !== "none"
    ? { laneId, name: androidLaneDeviceName(lane), state: lane.state, avdName: lane.device.avdName, origin: lane.device.origin }
    : null;
  emitCard(entry);
}

function scheduleRead(entry: CardEntry): void {
  if (entry.timer != null) window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => {
    entry.timer = null;
    void readCard(entry);
  }, EVENT_READ_DELAY_MS);
}

function openMachine(key: string, pin: OpenProjectBinding | null): MachineEntry {
  const existing = machines.get(key);
  if (existing) return existing;
  const machine: MachineEntry = { key, pin, lanes: new Map(), unsubscribe: null };
  machines.set(key, machine);
  machine.unsubscribe = window.ade?.androidEmulator?.onEvent?.((event) => {
    if (event.type === "android.inventory.changed") {
      for (const entry of machine.lanes.values()) scheduleRead(entry);
      return;
    }
    if (event.type !== "android.device.state") return;
    const entry = machine.lanes.get(event.laneId);
    if (!entry) return;
    // The event's own state moves the card at once, ahead of the read.
    const current = entry.card;
    if (event.state !== "none" && current && current.state !== event.state) {
      entry.card = { ...current, state: event.state };
      emitCard(entry);
    }
    scheduleRead(entry);
  }, pin) ?? null;
  return machine;
}

/** Joins a lane's reading on a machine. The first reader starts the read. */
function joinCard(machineKey: string, laneId: string, pin: OpenProjectBinding | null, reader: () => void): () => void {
  const machine = openMachine(machineKey, pin);
  let entry = machine.lanes.get(laneId);
  if (!entry) {
    entry = { laneId, machine, card: null, failed: false, readSeq: 0, readers: new Set(), timer: null };
    machine.lanes.set(laneId, entry);
    void readCard(entry);
  } else if (entry.failed) {
    entry.failed = false;
    void readCard(entry);
  }
  const joined = entry;
  joined.readers.add(reader);
  return () => {
    joined.readers.delete(reader);
    if (joined.readers.size > 0) return;
    if (joined.timer != null) window.clearTimeout(joined.timer);
    machine.lanes.delete(laneId);
    if (machine.lanes.size > 0) return;
    machine.unsubscribe?.();
    machines.delete(machineKey);
  };
}

function peekCard(machineKey: string, laneId: string): AndroidLaneDeviceCard | null {
  return machines.get(machineKey)?.lanes.get(laneId)?.card ?? null;
}

/** The menu's refresh: read the lane again now. */
function refreshCard(machineKey: string, laneId: string): void {
  const entry = machines.get(machineKey)?.lanes.get(laneId);
  if (entry) void readCard(entry);
}

export function useAndroidLaneDeviceCard(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
  /** Bump to read again now: the card menu's refresh after it acts (the web client may get no event). */
  refreshKey?: unknown;
}): AndroidLaneDeviceCard | null {
  const { laneId, runtimePin, enabled, refreshKey } = args;
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  // Keyed on the machine, not the pin object. The empty key is the tab's own machine.
  const machineKey = runtimePin?.key ?? "";
  const lane = enabled && laneId && typeof window.ade?.androidEmulator?.getStatus === "function" ? laneId : null;

  const subscribe = useCallback(
    (reader: () => void) => (lane ? joinCard(machineKey, lane, pinRef.current, reader) : () => {}),
    [lane, machineKey],
  );
  const getSnapshot = useCallback(() => (lane ? peekCard(machineKey, lane) : null), [lane, machineKey]);
  const card = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (Object.is(lastRefreshKey.current, refreshKey)) return;
    lastRefreshKey.current = refreshKey;
    if (lane) refreshCard(machineKey, lane);
  }, [lane, machineKey, refreshKey]);

  return androidLaneDeviceForLane(card, laneId);
}

/** Only the reading FOR this lane: a menu on the last lane's reading would act on the wrong lane's device. */
export function androidLaneDeviceForLane(
  card: AndroidLaneDeviceCard | null,
  laneId: string | null,
): AndroidLaneDeviceCard | null {
  return card && laneId && card.laneId === laneId ? card : null;
}
