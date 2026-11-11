/**
 * One lane per ADE Cloud computer, counted across every project on it.
 *
 * Each project keeps its lanes in its own database, so a project alone
 * cannot see a lane another project on the same computer holds. A second
 * project cloned onto the computer would then get a lane of its own. This
 * module is the computer-wide view the lane service asks before a lane row
 * comes to exist (`laneService.ts`: create, import, and the adoption of a
 * worktree found on disk):
 *
 * - The lanes of this project (the caller passes them) and of every other
 *   project on the computer: the ones in the machine's project list and the
 *   ones that ever claimed a lane here. Another project's database is read
 *   read-only, without starting it.
 * - A claim file (`cloud-computer-lanes.json` in the machine's ADE folder)
 *   under one lock file, so two processes (the brain and a one-shot
 *   `ade --headless`) that create a lane at the same moment cannot both
 *   pass. The claim is given back once the insert ends; one a dead process
 *   left behind stops counting after two minutes.
 *
 * The machine's ADE folder falls back to the account's home from the password
 * database, not from `HOME`, so a process with a changed environment still
 * finds the files. A normal computer never reads or writes any of this.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExclusiveFileLockTimeoutError, withExclusiveFileLockSync } from "../../../../../ade-cli/src/lib/exclusiveFileLock";
import { pathsEqual } from "../shared/pathCompare";
import { writeFileAtomic } from "../state/durableFile";
import { hasTable, openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { AdeExpectedError } from "../../../shared/expectedError";
import { captureError } from "../../../shared/sentry/capture";
import {
  CLOUD_COMPUTER_LANE_CHECK_BUSY_MESSAGE,
  CloudComputerLaneLimitError,
  isAdeCloudComputer,
} from "./cloudComputerRules";

/** A lane row as the rule reads it. Primary lanes never count and are not passed. */
export type CloudComputerLaneRow = { id: string; name: string | null; status: string | null };

type LaneHolder = { name: string | null; archived: boolean };

type ClaimFile = {
  version: 1;
  /** Every project root that claimed a lane on this computer. */
  projects: string[];
  claims: Array<{ projectRoot: string; laneId: string; at: number }>;
};

/** How long a claim counts without its lane row: longer than any insert. */
const CLAIM_TTL_MS = 2 * 60_000;

/**
 * The file only the ADE Cloud machine template installs (`infra/ade-cloud/
 * template/Dockerfile`), owned by root. It marks the computer even for a
 * process whose environment lost `ADE_CLOUD_INSTANCE_ID` (an agent shell with
 * a filtered environment that runs `ade --headless`).
 */
const CLOUD_IMAGE_MARKER = "/usr/local/bin/ade-entrypoint.sh";
let cloudImageMarkerPresent: boolean | null = null;

/**
 * Whether the one-lane rule applies to this process: the cloud variable, or
 * the machine template's own file on Linux. Never true on macOS or Windows
 * without the variable.
 */
export function cloudComputerLaneRuleApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAdeCloudComputer(env)) return true;
  if (process.platform !== "linux") return false;
  cloudImageMarkerPresent ??= fs.existsSync(CLOUD_IMAGE_MARKER);
  return cloudImageMarkerPresent;
}

function accountHome(): string {
  try {
    const home = os.userInfo().homedir;
    if (home) return home;
  } catch {
    // No password entry (a container user without one): fall back to HOME.
  }
  return os.homedir();
}

/**
 * The machine's ADE folder: `ADE_HOME`, else `.ade` in the account's home.
 * On a cloud computer both name `/home/node/.ade`, so a process that lost
 * `ADE_HOME` still finds the same files.
 */
function machineAdeDir(): string {
  const explicit = process.env.ADE_HOME?.trim();
  return explicit ? path.resolve(explicit) : path.join(accountHome(), ".ade");
}

function claimFilePath(): string {
  return path.join(machineAdeDir(), "cloud-computer-lanes.json");
}

function claimLockPath(): string {
  return path.join(machineAdeDir(), "cloud-computer-lanes.lock");
}

function machineProjectListPath(): string {
  return path.join(machineAdeDir(), "projects.json");
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    // No file yet is the usual answer; an unreadable one is worth a report.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      captureError(error, { level: "warning", tags: { area: "cloud_lane_hold" }, extra: { file: path.basename(filePath) }, fingerprint: ["cloud_lane_hold", "read_failed"] });
    }
    return null;
  }
}

function readClaimFile(): ClaimFile {
  const parsed = readJson(claimFilePath()) as Partial<ClaimFile> | null;
  const projects = Array.isArray(parsed?.projects)
    ? parsed.projects.filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    : [];
  const claims = Array.isArray(parsed?.claims)
    ? parsed.claims.filter((claim): claim is ClaimFile["claims"][number] =>
      Boolean(claim)
      && typeof claim.projectRoot === "string"
      && typeof claim.laneId === "string"
      && typeof claim.at === "number")
    : [];
  return { version: 1, projects, claims };
}

function machineProjectRoots(): string[] {
  const projects = (readJson(machineProjectListPath()) as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) return [];
  return projects
    .map((entry) => (entry && typeof entry === "object" ? (entry as { rootPath?: unknown }).rootPath : null))
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0);
}

function realpathOr(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function sameProject(a: string, b: string): boolean {
  return pathsEqual(path.resolve(a), path.resolve(b)) || pathsEqual(realpathOr(a), realpathOr(b));
}

function firstHolder(rows: CloudComputerLaneRow[]): LaneHolder | null {
  const active = rows.find((row) => row.status !== "archived");
  if (active) return { name: active.name, archived: false };
  const archived = rows.find((row) => row.status === "archived");
  return archived ? { name: archived.name ?? "", archived: true } : null;
}

/**
 * The lanes another project on this computer holds, read from its database
 * without starting it. A database that exists but cannot be read counts as
 * holding a lane: the rule fails closed on this computer.
 */
function otherProjectLanes(projectRoot: string): CloudComputerLaneRow[] | "unreadable" {
  const dbPath = path.join(projectRoot, ".ade", "ade.db");
  if (!fs.existsSync(dbPath)) return [];
  let db: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    if (!hasTable(db, "lanes")) return [];
    return db.prepare(
      "select id, name, status from lanes where lane_type != 'primary' order by created_at asc",
    ).all<CloudComputerLaneRow>();
  } catch {
    return "unreadable";
  } finally {
    try { db?.close(); } catch { /* read-only; nothing to keep */ }
  }
}

function findHolder(projectRoot: string, ownLanes: CloudComputerLaneRow[], claimFile: ClaimFile, nowMs: number): LaneHolder | null {
  const own = firstHolder(ownLanes);
  if (own) return own;
  const others: string[] = [];
  for (const root of [...machineProjectRoots(), ...claimFile.projects]) {
    if (sameProject(root, projectRoot) || others.some((seen) => sameProject(seen, root))) continue;
    others.push(root);
  }
  for (const root of others) {
    const lanes = otherProjectLanes(root);
    if (lanes === "unreadable") return { name: null, archived: false };
    const holder = firstHolder(lanes);
    if (holder) return holder;
    // A lane another process is inserting right now: its row is not there yet.
    const inFlight = claimFile.claims.some((claim) =>
      nowMs - claim.at < CLAIM_TTL_MS
      && sameProject(claim.projectRoot, root)
      && !lanes.some((lane) => lane.id === claim.laneId));
    if (inFlight) return { name: null, archived: false };
  }
  return null;
}

function refusal(holder: LaneHolder): CloudComputerLaneLimitError {
  return new CloudComputerLaneLimitError(holder.archived ? holder.name ?? "" : null);
}

/**
 * Refuses a new lane when this cloud computer already holds one, in this
 * project (`ownLanes`) or in any other. Reads only; the early check before
 * any git work. Call it only where `cloudComputerLaneRuleApplies()` is true.
 */
export function assertCloudComputerHasRoomForLane(args: { projectRoot: string; ownLanes: CloudComputerLaneRow[] }): void {
  const holder = findHolder(args.projectRoot, args.ownLanes, readClaimFile(), Date.now());
  if (holder) throw refusal(holder);
}

/**
 * The same check under the computer-wide lock, and then a claim for
 * `laneId`, so another process that checks before this lane row exists sees
 * the claim. Run it right before the insert, in the same synchronous step.
 * Once the insert committed (the row counts from then on) or failed,
 * `releaseCloudComputerLaneClaim` gives the claim back; a claim left behind
 * (the process died) stops counting after two minutes.
 */
export function claimCloudComputerLane(args: { projectRoot: string; laneId: string; ownLanes: () => CloudComputerLaneRow[] }): void {
  try {
    withExclusiveFileLockSync(claimLockPath(), () => {
      const nowMs = Date.now();
      const claimFile = readClaimFile();
      const holder = findHolder(args.projectRoot, args.ownLanes(), claimFile, nowMs);
      if (holder) throw refusal(holder);
      const projects = claimFile.projects.some((root) => sameProject(root, args.projectRoot))
        ? claimFile.projects
        : [...claimFile.projects, path.resolve(args.projectRoot)];
      const claims = claimFile.claims.filter((claim) => nowMs - claim.at < CLAIM_TTL_MS);
      claims.push({ projectRoot: path.resolve(args.projectRoot), laneId: args.laneId, at: nowMs });
      writeFileAtomic(claimFilePath(), `${JSON.stringify({ version: 1, projects, claims } satisfies ClaimFile)}\n`);
    }, { waitMs: 5_000, label: "the ADE Cloud lane lock", staleAfterMs: 30_000 });
  } catch (error) {
    if (error instanceof ExclusiveFileLockTimeoutError) throw new AdeExpectedError(CLOUD_COMPUTER_LANE_CHECK_BUSY_MESSAGE, "user");
    throw error;
  }
}

/** Gives back the claim of an insert that committed or failed. Best effort. */
export function releaseCloudComputerLaneClaim(projectRoot: string, laneId: string): void {
  try {
    withExclusiveFileLockSync(claimLockPath(), () => {
      const claimFile = readClaimFile();
      const claims = claimFile.claims.filter((claim) => !(claim.laneId === laneId && sameProject(claim.projectRoot, projectRoot)));
      if (claims.length === claimFile.claims.length) return;
      writeFileAtomic(claimFilePath(), `${JSON.stringify({ ...claimFile, claims } satisfies ClaimFile)}\n`);
    }, { waitMs: 2_000, label: "the ADE Cloud lane lock", staleAfterMs: 30_000 });
  } catch (error) {
    // The claim stops counting on its own after two minutes.
    captureError(error, { level: "warning", tags: { area: "cloud_lane_hold" }, fingerprint: ["cloud_lane_hold", "release_failed"] });
  }
}
