import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AppleInstalledSimulator, AppleSimulatorOwnershipInfo } from "../../../shared/types/iosSimulator";
import { pathsEqual } from "../shared/pathCompare";

/**
 * The file that proves a simulator is ADE's.
 *
 * ADE writes it into the directory of every device it makes. The marker, not
 * only the lane row, is the evidence: a row can be lost, and an unmarked
 * leaked device looks exactly like the user's own and is kept forever. The
 * cleanup pass deletes a marked device of this project that no live lane
 * holds. CoreSimulator deletes the whole directory with the device, marker
 * included.
 */

const APPLE_DEVICE_MARKER_FILE = "ade-lane-device.json" as const;

/**
 * A marked device younger than this is never deleted by the cleanup pass.
 * Create writes the marker before the lane row, so a create in flight has a
 * marker and no row for a moment. A detach restarts the clock, so the user
 * can still pick the device again before it goes.
 */
export const APPLE_DEVICE_MARKER_GRACE_MS = 5 * 60_000;

export type AppleDeviceMarker = {
  version: 1;
  projectRoot: string;
  laneId: string;
  name: string;
  createdAt: string;
  /**
   * Set when the lane gave the device up without deleting it (`deviceDetach`).
   * The device is then a leftover: the cleanup pass never gives it back to the
   * lane, and deletes it after the grace period unless a lane picks it again.
   */
  detachedAt?: string | null;
  /**
   * Set when the person released the device and chose to keep it as a free
   * simulator (`deviceDetach` with `keep`). The cleanup pass then neither
   * deletes it nor gives it back to its old lane; it stays until a lane
   * attaches it (which clears this) or the person deletes it from the picker.
   */
  keptAt?: string | null;
  /** One of the lane's extra devices: a lost row is given back as an extra, never as the lane's own device. */
  extra?: boolean;
};

export function appleDeviceMarkerPath(dataRoot: string, udid: string): string {
  return path.join(dataRoot, udid, APPLE_DEVICE_MARKER_FILE);
}

export function readAppleDeviceMarker(dataRoot: string, udid: string): AppleDeviceMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(appleDeviceMarkerPath(dataRoot, udid), "utf8")) as Partial<AppleDeviceMarker>;
    if (typeof raw.projectRoot !== "string" || typeof raw.laneId !== "string") return null;
    return {
      version: 1,
      projectRoot: raw.projectRoot,
      laneId: raw.laneId,
      name: typeof raw.name === "string" ? raw.name : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      detachedAt: typeof raw.detachedAt === "string" ? raw.detachedAt : null,
      ...(typeof raw.keptAt === "string" ? { keptAt: raw.keptAt } : {}),
      ...(raw.extra === true ? { extra: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Write the marker. Only into a directory that exists: CoreSimulator creates it
 * with the device, and a marker without its device would describe nothing.
 */
export function writeAppleDeviceMarker(dataRoot: string, udid: string, marker: AppleDeviceMarker): boolean {
  const directory = path.join(dataRoot, udid);
  if (!fs.existsSync(directory)) return false;
  fs.writeFileSync(appleDeviceMarkerPath(dataRoot, udid), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return true;
}

/** Every marked device directory under the device store. Unreadable entries are skipped. */
export function listAppleDeviceMarkers(dataRoot: string): Array<{ udid: string; marker: AppleDeviceMarker }> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataRoot);
  } catch {
    return [];
  }
  const found: Array<{ udid: string; marker: AppleDeviceMarker }> = [];
  for (const udid of entries) {
    if (!/^[0-9A-F-]{20,}$/iu.test(udid)) continue;
    const marker = readAppleDeviceMarker(dataRoot, udid);
    if (marker) found.push({ udid, marker });
  }
  return found;
}

/** The marker belongs to the project at `projectRoot`. */
export function appleMarkerIsProject(marker: AppleDeviceMarker, projectRoot: string): boolean {
  return pathsEqual(path.resolve(marker.projectRoot), path.resolve(projectRoot));
}

/** `ADE · lane`, `ADE Repro`: a name ADE made, or a person named after it. Evidence only for the storage view. */
export function looksLikeAdeDeviceName(name: string): boolean {
  return /^ADE(\s|·|$)/u.test(name.trim());
}

/** Who each installed simulator belongs to, for the storage view: a lane, ADE (this or another project), or unknown. */
export function appleSimulatorOwnership(input: {
  installed: readonly AppleInstalledSimulator[];
  heldUdids: ReadonlySet<string>;
  dataRoot: string;
  projectRoot: string | null;
  /** Another project still uses (or may use) this device of its own. */
  foreignInUse: (marker: AppleDeviceMarker, udid: string) => boolean;
}): AppleSimulatorOwnershipInfo[] {
  return input.installed.map((device) => {
    const marker = readAppleDeviceMarker(input.dataRoot, device.udid);
    let ownership: AppleSimulatorOwnershipInfo["ownership"] = "unknown";
    const foreign = Boolean(marker && input.projectRoot && !appleMarkerIsProject(marker, input.projectRoot));
    if (input.heldUdids.has(device.udid)) ownership = "lane";
    else if (marker?.keptAt) ownership = "ade-kept";
    else if (marker && foreign && input.foreignInUse(marker, device.udid)) ownership = "ade-other-project";
    else if (marker) ownership = "ade-orphan";
    // A released ADE device waits out the grace, then the next pass deletes it.
    const detachedMs = ownership === "ade-orphan" && marker?.detachedAt ? Date.parse(marker.detachedAt) : Number.NaN;
    return {
      udid: device.udid,
      ownership,
      markerLaneId: marker?.laneId ?? null,
      looksLikeAde: !marker && looksLikeAdeDeviceName(device.name),
      ...(Number.isFinite(detachedMs) ? { deletesAfter: new Date(detachedMs + APPLE_DEVICE_MARKER_GRACE_MS).toISOString() } : {}),
    };
  });
}

/**
 * Where a project that moved went: the old folder's own `.ade/moved-to.json`
 * (a kept copy), else the machine's move journal
 * (`<ADE_HOME>/project-moves/*.json`, a finished move from that root). Null
 * when neither says. Read here rather than imported from the CLI's move code,
 * which imports this file.
 */
export function appleProjectMovedTo(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ".ade", "moved-to.json"), "utf8")) as { movedTo?: unknown };
    if (typeof parsed.movedTo === "string" && parsed.movedTo.trim()) return parsed.movedTo;
  } catch {
    // No kept copy at that root (or an unreadable marker): ask the journal.
  }
  // The same home the move journal is written to (moveJournal.ts).
  const dir = path.join(resolveMachineAdeDir(env), "project-moves");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  let best: { to: string; at: number } | null = null;
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
        sourceRoot?: unknown; destinationRoot?: unknown; state?: unknown; finishedAt?: unknown;
      };
      if (record.state !== "done" || typeof record.sourceRoot !== "string" || typeof record.destinationRoot !== "string") continue;
      if (!pathsEqual(path.resolve(record.sourceRoot), path.resolve(root))) continue;
      const at = typeof record.finishedAt === "number" ? record.finishedAt : 0;
      if (!best || at > best.at) best = { to: record.destinationRoot, at };
    } catch {
      // One unreadable record does not hide the others.
    }
  }
  return best?.to ?? null;
}

/**
 * The marker names a folder this project moved away from (one or more
 * moves): the device is this project's, though the move did not rewrite its
 * marker.
 */
export function appleMarkerMovedToProject(
  marker: AppleDeviceMarker,
  projectRoot: string,
  movedTo: (root: string) => string | null = (root) => appleProjectMovedTo(root),
): boolean {
  const target = path.resolve(projectRoot);
  const seen: string[] = [];
  let root = marker.projectRoot;
  for (let hop = 0; hop < 5; hop += 1) {
    seen.push(path.resolve(root));
    const next = movedTo(root);
    if (!next) return false;
    if (pathsEqual(path.resolve(next), target)) return true;
    if (seen.some((each) => pathsEqual(each, path.resolve(next)))) return false;
    root = next;
  }
  return false;
}

/**
 * Does the project named in the marker still use the device?
 *
 * Read from that project's own database, read-only: one lane row holding the
 * udid, with a lane that is not archived, means `held`. `gone` when the
 * project, or its database, is no longer on disk. `unknown` when the database
 * is there but could not be read (locked, older schema): nothing is decided on
 * a guess.
 *
 * A project that moved is followed to where it went (`movedTo`, up to five
 * moves): a marker the move did not rewrite still names the old folder, and
 * "the old folder is gone" must not delete a device the moved project's lane
 * still holds.
 */
export function appleMarkerProjectHolds(
  marker: AppleDeviceMarker,
  udid: string,
  openDatabase: (dbPath: string) => { prepare: (sql: string) => { get: (...params: string[]) => unknown }; close: () => void },
  movedTo: (root: string) => string | null = (root) => appleProjectMovedTo(root),
): "held" | "free" | "gone" | "unknown" {
  const seen: string[] = [];
  let root = marker.projectRoot;
  let answer: "held" | "free" | "gone" | "unknown" = "gone";
  for (let hop = 0; hop < 6; hop += 1) {
    seen.push(path.resolve(root));
    const here = projectHoldsAt(root, marker, udid, openDatabase);
    // A later root's answer wins only over "gone"/"free": a kept copy that
    // still reads "held" is never overruled into a delete.
    if (hop === 0 || answer === "gone" || (answer === "free" && here !== "gone")) answer = here;
    if (answer === "held" || answer === "unknown") return answer;
    const next = movedTo(root);
    if (!next || seen.some((each) => pathsEqual(each, path.resolve(next)))) break;
    root = next;
  }
  return answer;
}

function projectHoldsAt(
  projectRoot: string,
  marker: AppleDeviceMarker,
  udid: string,
  openDatabase: (dbPath: string) => { prepare: (sql: string) => { get: (...params: string[]) => unknown }; close: () => void },
): "held" | "free" | "gone" | "unknown" {
  const dbPath = path.join(projectRoot, ".ade", "ade.db");
  if (!fs.existsSync(projectRoot) || !fs.existsSync(dbPath)) return "gone";
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath);
    // A lane's extra device lives in its own table; only a marker that says
    // so asks it, so a database from before extras is never read for one.
    const table = marker.extra ? "lane_apple_extra_devices" : "lane_apple_devices";
    const row = db.prepare(
      `select 1 as one from ${table} d
         join lanes l on l.id = d.lane_id
        where d.udid = ? and coalesce(l.status, '') != 'archived'
        limit 1`,
    ).get(udid);
    return row ? "held" : "free";
  } catch {
    return "unknown";
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle has nothing to lose.
    }
  }
}
