import type { AdeSyncClient } from "../sync/client";
import type { WebMachineWorkspaceSnapshot } from "./WebMachineSessionManager";

// ---------------------------------------------------------------------------
// The account's cloud machines, as the cloud reports them.
//
// The browser never holds the cloud key. Every ADE brain of the account can
// list and wake the account's cloud machines (the phone's cloud page uses the
// same `agent37.read` / `agent37.write` commands), so the web asks a machine
// this tab is already connected to. Each call names the session it runs on.
// ---------------------------------------------------------------------------

export type WebCloudMachineState = "awake" | "asleep" | "starting" | "stopping" | "unknown";

export type WebCloudMachine = {
  machineKey: string;
  instanceId: string;
  state: WebCloudMachineState;
  /** "Box · 2 vCPU · 4 GB", as the cloud list words it. */
  size: string | null;
};

export type WebCloudMachines = {
  byMachineKey: ReadonlyMap<string, WebCloudMachine>;
  /** Keys this browser once saw as cloud machines that the cloud no longer lists. */
  deletedMachineKeys: ReadonlySet<string>;
  /** The session the list was read through. */
  readThroughTargetId: string;
};

const READ_ACTION = "agent37.read";
const WRITE_ACTION = "agent37.write";
const SEEN_STORAGE_KEY = "ade.web.cloudMachineKeys.v1";

function cloudState(value: unknown): WebCloudMachineState {
  switch (value) {
    case "running":
      return "awake";
    case "asleep":
    case "sleeping":
    case "stopped":
      return "asleep";
    case "starting":
    case "waking":
      return "starting";
    case "stopping":
      return "stopping";
    default:
      return "unknown";
  }
}

function parseCloudList(value: unknown): WebCloudMachine[] {
  const machines = value && typeof value === "object" && Array.isArray((value as { machines?: unknown }).machines)
    ? (value as { machines: unknown[] }).machines
    : [];
  const rows: WebCloudMachine[] = [];
  for (const entry of machines) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const machineKey = typeof record.machineKey === "string" ? record.machineKey.trim() : "";
    const instanceId = typeof record.instanceId === "string" ? record.instanceId.trim() : "";
    if (!machineKey || !instanceId) continue;
    rows.push({
      machineKey,
      instanceId,
      state: cloudState(record.state),
      size: typeof record.size === "string" && record.size.trim() ? record.size.trim() : null,
    });
  }
  return rows;
}

function readSeenKeys(storage: Storage | null): Set<string> {
  try {
    const raw = storage?.getItem(SEEN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeenKeys(storage: Storage | null, keys: ReadonlySet<string>): void {
  try {
    storage?.setItem(SEEN_STORAGE_KEY, JSON.stringify([...keys].slice(-200)));
  } catch {
    // A full or blocked storage only loses the "deleted" hint.
  }
}

/** Live sessions that offer the cloud commands, the active one first. */
function cloudCapableClients(
  snapshot: WebMachineWorkspaceSnapshot,
  getClient: (targetId: string) => AdeSyncClient | null,
  action: string,
): Array<{ targetId: string; client: AdeSyncClient }> {
  const live = snapshot.sessions
    .filter((session) => session.state === "live")
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const capable: Array<{ targetId: string; client: AdeSyncClient }> = [];
  for (const session of live) {
    const client = getClient(session.targetId);
    if (!client) continue;
    if (!client.getCommandDescriptors().some((descriptor) => descriptor.action === action)) continue;
    capable.push({ targetId: session.targetId, client });
  }
  return capable;
}

/**
 * The cloud list, through the first connected machine that answers. Null when
 * no connected machine can list them (none connected yet, or none of them has
 * the account's cloud connection).
 */
export async function readWebCloudMachines(args: {
  snapshot: WebMachineWorkspaceSnapshot;
  getClient: (targetId: string) => AdeSyncClient | null;
  storage?: Storage | null;
}): Promise<WebCloudMachines | null> {
  const storage = args.storage ?? null;
  for (const { targetId, client } of cloudCapableClients(args.snapshot, args.getClient, READ_ACTION)) {
    let answer: unknown;
    try {
      answer = await client.sendCommand(READ_ACTION, { action: "list" }, { timeoutMs: 20_000 });
    } catch {
      continue;
    }
    const rows = parseCloudList(answer);
    const byMachineKey = new Map(rows.map((row) => [row.machineKey, row]));
    const seen = readSeenKeys(storage);
    const deletedMachineKeys = new Set([...seen].filter((key) => !byMachineKey.has(key)));
    writeSeenKeys(storage, new Set([...seen, ...byMachineKey.keys()]));
    return { byMachineKey, deletedMachineKeys, readThroughTargetId: targetId };
  }
  return null;
}

/** Wake one cloud machine through a connected machine. Throws the cloud's own refusal. */
export async function wakeWebCloudMachine(args: {
  snapshot: WebMachineWorkspaceSnapshot;
  getClient: (targetId: string) => AdeSyncClient | null;
  machineKey: string;
}): Promise<void> {
  const capable = cloudCapableClients(args.snapshot, args.getClient, WRITE_ACTION);
  if (capable.length === 0) {
    throw new Error("Connect to one of your machines first: it wakes the cloud machine for you.");
  }
  let lastError: unknown = null;
  for (const { client } of capable) {
    try {
      await client.sendCommand(WRITE_ACTION, { action: "wake", args: { machine: args.machineKey } }, { timeoutMs: 90_000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The cloud machine could not be woken.");
}

/** The row's state line for a cloud machine, e.g. "Asleep · Box · 2 vCPU · 4 GB". */
export function webCloudMachineStatusLine(machine: WebCloudMachine): string {
  const state = {
    awake: "Awake",
    asleep: "Asleep",
    starting: "Waking",
    stopping: "Going to sleep",
    unknown: "Cloud machine",
  }[machine.state];
  return machine.size ? `${state} · ${machine.size}` : state;
}
