/**
 * Contract C2 for pins that outlive their saved connection.
 *
 * A pin names a machine by this computer's saved connection id (`targetId`).
 * That id can go away while pins to it still exist: the connection was
 * removed, a lane's computer moved (the old one's connection is forgotten),
 * or the connection was saved again under a new id. A chat pinned to it then
 * failed every call with "Remote target was not found".
 *
 * This remembers which machine each removed connection reached, and where a
 * lane went when its computer moved, so a pin to a gone connection still
 * reaches its machine: by its machine key, to the connection saved for that
 * machine now, or through the account (C2 `connect`) when none is saved.
 *
 * Kept on disk (this app's data folder), at most `MAX_ENTRIES` connections.
 */

import fs from "node:fs";
import { safeJsonParse, writeTextAtomic } from "../shared/utils";

const MAX_ENTRIES = 200;

type Entry = { targetId: string; machineKey: string; atMs: number };

let filePath: string | null = null;
let entries: Entry[] | null = null;
let reach: ((machineKey: string) => Promise<string | null>) | null = null;

function load(): Entry[] {
  if (entries) return entries;
  entries = [];
  if (!filePath) return entries;
  try {
    const parsed = safeJsonParse<unknown>(fs.readFileSync(filePath, "utf8"), null);
    if (Array.isArray(parsed)) {
      entries = parsed.flatMap((row): Entry[] => {
        if (!row || typeof row !== "object") return [];
        const value = row as Record<string, unknown>;
        return typeof value.targetId === "string" && typeof value.machineKey === "string"
          ? [{ targetId: value.targetId, machineKey: value.machineKey, atMs: typeof value.atMs === "number" ? value.atMs : 0 }]
          : [];
      });
    }
  } catch {
    // Nothing remembered yet.
  }
  return entries;
}

function save(): void {
  if (!filePath || !entries) return;
  try {
    writeTextAtomic(filePath, JSON.stringify(entries));
  } catch {
    // Best effort: a pin to a gone connection then fails as it did before.
  }
}

/** Where the memory is kept; set once at startup. */
export function configureGoneTargets(options: { filePath: string }): void {
  filePath = options.filePath;
  entries = null;
}

/** How a pin's machine is reached when no connection is saved for it (C2 `connect`); returns the new connection id. */
export function setGoneTargetReach(next: ((machineKey: string) => Promise<string | null>) | null): void {
  reach = next;
}

/** A saved connection to `machineKey` is about to be removed. */
export function noteGoneTarget(targetId: string, machineKey: string | null | undefined): void {
  const key = machineKey?.trim();
  if (!targetId || !key) return;
  const list = load().filter((entry) => entry.targetId !== targetId);
  list.push({ targetId, machineKey: key, atMs: Date.now() });
  entries = list.slice(-MAX_ENTRIES);
  save();
}

/** A lane's computer moved: pins that reached the old machine now reach the new one (contract C3). */
export function redirectGoneTargets(fromMachineKey: string | null | undefined, toMachineKey: string | null | undefined): void {
  const from = fromMachineKey?.trim().toLowerCase();
  const to = toMachineKey?.trim();
  if (!from || !to) return;
  let changed = false;
  for (const entry of load()) {
    if (entry.machineKey.toLowerCase() === from) {
      entry.machineKey = to;
      changed = true;
    }
  }
  if (changed) save();
}

/** The machine a gone connection reached, or null. */
export function goneTargetMachineKey(targetId: string | null | undefined): string | null {
  if (!targetId) return null;
  return load().find((entry) => entry.targetId === targetId)?.machineKey ?? null;
}

/**
 * Reaches the machine of a gone connection through the account (pairing it
 * again, which wakes a sleeping cloud computer). The new connection id, or
 * null when it can't.
 */
export async function reachGoneTarget(targetId: string): Promise<string | null> {
  const key = goneTargetMachineKey(targetId);
  if (!key || !reach) return null;
  return await reach(key).catch(() => null);
}
