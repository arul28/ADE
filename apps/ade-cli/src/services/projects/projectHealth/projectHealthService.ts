import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdeDb } from "../../../../../desktop/src/main/services/state/kvDb";
import type { Logger } from "../../../../../desktop/src/main/services/logging/logger";
import type { LaneSummary } from "../../../../../desktop/src/shared/types";
import type {
  ProjectHealthFixResult,
  ProjectHealthIssue,
  ProjectHealthReport,
  ProjectLaneHealth,
  ProjectLaneStaleReason,
} from "../../../../../desktop/src/shared/types/projectHealth";
import { formatBytes } from "../../../../../desktop/src/shared/formatting";
import { isChatToolType } from "../../../../../desktop/src/shared/sessionSpawnNesting";
import { listAppleDeviceMarkers } from "../../../../../desktop/src/main/services/ios/appleDeviceMarker";
import {
  applyAgentHistoryRenames,
  carryClaudeProjectSettings,
  carryCodexTrust,
  carryCopilotTrust,
  planAgentHistoryRenames,
} from "../projectMove/moveAgentHistory";
import { countPathsNaming, rewritePathsInDatabase, type PathRewriteDb } from "../projectMove/moveDatabase";
import { listSymlinks, relinkAbsoluteSymlinks, remapUnderRoot, rewriteWorktreeLinksInCopy, rootSpellings } from "../projectMove/moveGitLinks";
import { listMoveRecords } from "../projectMove/moveJournal";
import { previousProjectRoots } from "../projectMove/movePreviousRoots";
import { rewriteAdeJsonFiles, rewriteSimulatorMarkers } from "../projectMove/projectMoveEngine";
import { filesMentioningPath, installCommandFor, lockfileKind, timeMachineBacksUp } from "../projectMove/projectMovePreflight";
import { readMoveVolume } from "../projectMove/moveVolumes";

/**
 * Project health: everything ADE knows can go wrong with a project, checked in
 * one pass, each with a fix where ADE can make it safely. Most checks matter
 * after a move (paths, git links, agent history, trust); the rest hold for any
 * project (missing lane folders, dependencies, virtualenvs, the drive).
 *
 * Checks only read. A fix runs only when the person presses it, and each fix
 * is the same code the move itself runs, so running it twice changes nothing.
 */

export type ProjectHealthTerminalRequest = {
  laneId: string;
  cwd: string;
  title: string;
  command: string;
};

export type ProjectHealthServiceDeps = {
  projectRoot: string;
  db: Pick<AdeDb, "all" | "run" | "runChanged">;
  logger: Pick<Logger, "info" | "warn">;
  listLanes: () => Promise<LaneSummary[]>;
  /** Opens a terminal in the lane and runs the command, so the person sees it. */
  openTerminal?: (request: ProjectHealthTerminalRequest) => Promise<void>;
  /**
   * The chat service's own turn state for these chats. A chat row says
   * `running` while the chat is open, whether or not a turn runs, so its
   * owner pid says nothing about being stuck. Without this, chats are never
   * reported stuck.
   */
  readChatTurnStates?: (sessionIds: string[]) => Promise<ProjectHealthChatTurnState[]>;
};

export type ProjectHealthChatTurnState = {
  sessionId: string;
  /** The chat service's status: `active` while a turn runs. */
  status: string;
  /** False when the host holds no provider runtime; absent when it cannot say. */
  runtimeAlive?: boolean;
  /** Another live brain holds the chat; its status here is not the truth. */
  ownedElsewhere?: boolean;
};

/**
 * The chat service, as `readChatTurnStates` needs it: one summary read for a
 * named set of chats. Both hosts that build this service (the desktop brain and
 * the CLI brain) read the same five options, so the shape lives here once.
 */
export type ProjectHealthChatSessionLister = {
  listSessions(
    laneId: string | undefined,
    options: {
      sessionIds: readonly string[];
      includeArchived: boolean;
      includeAutomation: boolean;
      includeIdentity: boolean;
      includeSideChats: boolean;
    },
  ): Promise<ReadonlyArray<{
    sessionId: string;
    status: string;
    runtimeAlive?: boolean;
    runtimeOwnedElsewhere?: unknown;
  }>>;
};

/**
 * `readChatTurnStates` from the chat service's own summaries.
 *
 * A host with no chat service still gets a reader (it answers nothing), so the
 * dependency is always wired and the rule stays in one place: a chat is stuck
 * only when the service says a turn runs and no runtime holds it.
 */
export function createProjectHealthTurnStateReader(
  service: ProjectHealthChatSessionLister | null | undefined,
): (sessionIds: string[]) => Promise<ProjectHealthChatTurnState[]> {
  return async (sessionIds) => {
    if (!service) return [];
    const summaries = await service.listSessions(undefined, {
      sessionIds,
      includeArchived: false,
      includeAutomation: true,
      includeIdentity: true,
      includeSideChats: true,
    });
    return summaries.map((summary) => ({
      sessionId: summary.sessionId,
      status: summary.status,
      ...(summary.runtimeAlive !== undefined ? { runtimeAlive: summary.runtimeAlive } : {}),
      ownedElsewhere: summary.runtimeOwnedElsewhere != null,
    }));
  };
}

const REPORT_CACHE_MS = 30_000;
/** A lane with no activity for this long, and no open PR, counts as stale. */
const STALE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
/** A git lock file older than this with no git running is a leftover from a crash. */
const STALE_LOCK_MS = 10 * 60_000;
const GIT_CONCURRENCY = 4;
const VENV_DIRS = [".venv", "venv", "env"];

type Checkout = { laneId: string; label: string; root: string; primary: boolean };

type Context = {
  projectRoot: string;
  previousRoots: string[];
  previousSpellings: string[];
  lanes: LaneSummary[];
  checkouts: Checkout[];
};

function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isWithinPath(root: string, target: string, allowEqual = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative) return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

function rewriteDb(db: ProjectHealthServiceDeps["db"]): PathRewriteDb {
  return {
    all: (sql, params) => db.all(sql, params),
    run: (sql, params) => db.runChanged(sql, params),
  };
}

/** Where a git checkout's `.git` file points, resolved, or null when it is not a linked worktree. */
function readGitdirPointer(laneRoot: string): string | null {
  try {
    const text = fs.readFileSync(path.join(laneRoot, ".git"), "utf8").trim();
    const match = text.match(/^gitdir:\s*(.+)$/u);
    return match ? path.resolve(laneRoot, match[1]!.trim()) : null;
  } catch {
    return null;
  }
}

function realpathOr(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** A lane is linked when its `.git` names this repo's admin folder and that folder names it back. */
function laneLinkProblem(projectRoot: string, laneRoot: string): string | null {
  const pointer = readGitdirPointer(laneRoot);
  if (!pointer) return "has no git link";
  const adminRoot = realpathOr(path.join(projectRoot, ".git", "worktrees"));
  const admin = realpathOr(pointer);
  if (path.dirname(admin) !== adminRoot) return exists(pointer) ? "belongs to another repository" : "points at a folder that is gone";
  try {
    const back = fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim();
    if (realpathOr(path.resolve(admin, back)) !== realpathOr(path.join(laneRoot, ".git"))) return "isn't linked back from the repository";
  } catch {
    return "isn't registered in the repository";
  }
  return null;
}

/**
 * A folder whose install produces packages. A scripts-only package is not an
 * install unit; a workspace root is, because its install creates dependencies
 * for the member packages too.
 */
function hasPackageInstall(root: string, logger: Pick<Logger, "warn">): boolean {
  const packageManager = lockfileKind(root);
  if (packageManager === null) return false;
  const manifestPath = path.join(root, "package.json");
  if (!exists(manifestPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    // Mid-edit or broken: still an install unit, as before this check read it,
    // so one bad lane manifest doesn't fail the whole dependency check.
    logger.warn("project_health.package_manifest_unreadable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const manifest = parsed as Record<string, unknown>;
  // Workspaces install their members' packages into the root.
  if (["dependencies", "devDependencies", "optionalDependencies", "workspaces"].some((field) => {
    const deps = manifest[field];
    return Boolean(deps) && typeof deps === "object" && Object.keys(deps as object).length > 0;
  })) return true;
  // pnpm keeps workspace membership in pnpm-workspace.yaml and the shared
  // lockfile, not package.json's `workspaces` field or member lockfiles.
  return packageManager === "pnpm" && exists(path.join(root, "pnpm-workspace.yaml"));
}

/** A virtualenv whose scripts name a folder other than its own was copied or moved, and its scripts break. */
function movedVirtualenvs(root: string): string[] {
  const found: string[] = [];
  for (const name of VENV_DIRS) {
    const venv = path.join(root, name);
    if (!exists(path.join(venv, "pyvenv.cfg"))) continue;
    try {
      const activate = fs.readFileSync(path.join(venv, "bin", "activate"), "utf8");
      const match = activate.match(/^\s*(?:export\s+)?VIRTUAL_ENV=["']?([^"'\n]+)["']?/mu);
      if (match && realpathOr(match[1]!.trim()) !== realpathOr(venv)) found.push(venv);
    } catch {
      // no activate script: not a standard venv
    }
  }
  return found;
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Folders in a checkout with their own package install: the checkout itself, `apps/*`, `packages/*`. */
function installUnits(checkoutRoot: string, logger: Pick<Logger, "warn">): string[] {
  const units = [checkoutRoot];
  for (const group of ["apps", "packages"]) {
    try {
      for (const entry of fs.readdirSync(path.join(checkoutRoot, group), { withFileTypes: true })) {
        if (entry.isDirectory()) units.push(path.join(checkoutRoot, group, entry.name));
      }
    } catch {
      // no such group
    }
  }
  return units.filter((unit) => hasPackageInstall(unit, logger));
}

type DependencyInstall = { checkout: Checkout; command: string };

/**
 * What to install where. A unit of the main checkout with no `node_modules`
 * needs an install there. Lanes are not checked for missing installs: new
 * lanes get no packages from ADE, only from a lane template. A lane made
 * before that change may still link its `node_modules` into the main
 * checkout; a dangling one is fixed by installing the main checkout, never by
 * installing the lane (that would replace a shared link with gigabytes of
 * copies). Links to anywhere else that is gone are reported as broken.
 */
function dependencyPlan(ctx: Context, logger: Pick<Logger, "warn">): { installs: DependencyInstall[]; brokenLinks: string[] } {
  const primary = ctx.checkouts.find((checkout) => checkout.primary) ?? null;
  const needs = new Map<Checkout, Set<string>>();
  const brokenLinks: string[] = [];
  const mark = (checkout: Checkout, unit: string) => {
    if (!needs.has(checkout)) needs.set(checkout, new Set());
    needs.get(checkout)!.add(unit);
  };
  for (const checkout of ctx.checkouts) {
    for (const unit of installUnits(checkout.root, logger)) {
      const nodeModules = path.join(unit, "node_modules");
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(nodeModules);
      } catch {
        stat = null;
      }
      const empty = stat?.isDirectory() === true && isEmptyDir(nodeModules);
      if (!stat || empty) {
        // A lane gets packages only from a lane template or its own install;
        // ADE gives a new lane none, so a lane without them is normal.
        if (checkout.primary) mark(checkout, unit);
        continue;
      }
      if (!stat.isSymbolicLink() || exists(nodeModules)) continue;
      let target = "";
      try {
        target = path.resolve(unit, fs.readlinkSync(nodeModules));
      } catch {
        // unreadable link
      }
      const targetRoot = target ? path.dirname(target) : "";
      if (primary && targetRoot && isWithinPath(primary.root, targetRoot, true) && !isWithinPath(path.join(primary.root, ".ade"), targetRoot, true)) {
        // A link to a folder that installs nothing has nothing to resolve.
        if (hasPackageInstall(targetRoot, logger)) mark(primary, targetRoot);
      } else {
        brokenLinks.push(nodeModules);
      }
    }
  }
  const installs: DependencyInstall[] = [];
  for (const [checkout, units] of needs) {
    const setup = installCommandFor(checkout.root);
    if (setup && setup.endsWith(" run setup")) {
      installs.push({ checkout, command: setup });
      continue;
    }
    const parts = [...units].sort().map((unit) => {
      const command = installCommandFor(unit) ?? "npm install";
      const relative = path.relative(checkout.root, unit);
      return relative ? `(cd ${JSON.stringify(relative)} && ${command})` : command;
    });
    installs.push({ checkout, command: parts.join(" && ") });
  }
  return { installs, brokenLinks };
}


function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", "-C", cwd, ...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function latest(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!best || Date.parse(value) > Date.parse(best)) best = value;
  }
  return best;
}

/** Git state of a lane: uncommitted files and commits on no remote. Nulls when git can't tell. */
async function laneGitState(root: string): Promise<{ dirty: boolean | null; changedFileCount: number | null; unpushedCommits: number | null }> {
  const [status, unpushed] = await Promise.all([
    gitOutput(root, ["status", "--porcelain", "--untracked-files=normal"]),
    gitOutput(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
  ]);
  const changed = status === null ? null : status.split("\n").filter((line) => line.trim()).length;
  const count = unpushed === null ? null : Number.parseInt(unpushed.trim(), 10);
  return {
    dirty: changed === null ? null : changed > 0,
    changedFileCount: changed,
    unpushedCommits: count === null || !Number.isFinite(count) ? null : count,
  };
}

/** Git leftovers in the repository: lock files from a crashed git, operations stopped halfway. */
function gitLeftovers(projectRoot: string, nowMs: number): string[] {
  const gitDir = path.join(projectRoot, ".git");
  const admins: Array<{ label: string; dir: string }> = [{ label: path.basename(projectRoot), dir: gitDir }];
  try {
    for (const name of fs.readdirSync(path.join(gitDir, "worktrees"))) admins.push({ label: name, dir: path.join(gitDir, "worktrees", name) });
  } catch {
    // no lanes
  }
  const found: string[] = [];
  for (const admin of admins) {
    for (const lock of ["index.lock", "HEAD.lock", "config.lock"]) {
      try {
        const stat = fs.statSync(path.join(admin.dir, lock));
        if (nowMs - stat.mtimeMs > STALE_LOCK_MS) found.push(`${admin.label}: ${lock} left by a git that stopped`);
      } catch {
        // none
      }
    }
    const stopped = [
      ["rebase-merge", "a rebase"],
      ["rebase-apply", "a rebase"],
      ["MERGE_HEAD", "a merge"],
      ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ].find(([file]) => exists(path.join(admin.dir, file!)));
    if (stopped) found.push(`${admin.label}: ${stopped[1]} was stopped halfway`);
  }
  return found;
}

export function createProjectHealthService(deps: ProjectHealthServiceDeps) {
  const projectRoot = path.resolve(deps.projectRoot);
  let cached: { at: number; report: Promise<ProjectHealthReport> } | null = null;

  async function context(): Promise<Context> {
    const previousRoots = previousProjectRoots(projectRoot);
    const lanes = (await deps.listLanes()).filter((lane) => !lane.archivedAt);
    const checkouts: Checkout[] = lanes
      .filter((lane) => lane.worktreePath && exists(lane.worktreePath))
      .map((lane) => ({
        laneId: lane.id,
        label: lane.laneType === "primary" ? path.basename(projectRoot) : lane.name,
        root: lane.worktreePath,
        primary: lane.laneType === "primary",
      }));
    return {
      projectRoot,
      previousRoots,
      previousSpellings: [...new Set(previousRoots.flatMap((root) => rootSpellings(root)))],
      lanes,
      checkouts,
    };
  }

  /** The old path of a path under the project, for tools that file history by path. */
  function oldPathsOf(ctx: Context, target: string): string[] {
    return ctx.previousRoots.flatMap((previous) => {
      const mapped = remapUnderRoot(target, rootSpellings(projectRoot), previous);
      return mapped ? [mapped] : [];
    });
  }

  function historyPlans(ctx: Context) {
    if (!ctx.previousSpellings.length) return [];
    const knownPaths = [...ctx.previousRoots, ...ctx.lanes.flatMap((lane) => oldPathsOf(ctx, lane.worktreePath))];
    return planAgentHistoryRenames({ oldSpellings: ctx.previousSpellings, newRoot: projectRoot, knownPaths })
      .filter((plan) => exists(plan.from));
  }

  function staleSimulatorMarkers(ctx: Context): number {
    if (!ctx.previousSpellings.length) return 0;
    const dataRoot = path.join(os.homedir(), "Library", "Developer", "CoreSimulator", "Devices");
    return listAppleDeviceMarkers(dataRoot).filter(({ marker }) => ctx.previousSpellings.includes(marker.projectRoot)).length;
  }

  async function symlinksNamingOldRoot(ctx: Context): Promise<string[]> {
    if (!ctx.previousSpellings.length) return [];
    const links = await listSymlinks(projectRoot).catch(() => [] as string[]);
    return links.filter((link) => {
      try {
        const target = fs.readlinkSync(link);
        return path.isAbsolute(target) && remapUnderRoot(target, ctx.previousSpellings, projectRoot) !== null;
      } catch {
        return false;
      }
    });
  }


  type SessionRow = {
    id: string;
    lane_id: string;
    tool_type: string | null;
    status: string | null;
    owner_pid: number | null;
    title: string | null;
    activity: string | null;
    /** cr-sqlite site that last wrote `owner_pid`: 0 is this machine. Null without sync tables. */
    owner_site: number | null;
  };

  /**
   * Which machine last wrote each row's owner. `terminal_sessions` syncs
   * between machines, and another machine's pid means nothing here. Its
   * cr-sqlite clock records the writer per column (site 0 is this machine).
   */
  function ownerSiteSql(): { select: string; join: string } {
    const none = { select: "null as owner_site", join: "" };
    try {
      const tables = deps.db.all<{ name: string }>(
        `select name from sqlite_master where type = 'table'
           and name in ('terminal_sessions__crsql_clock', 'terminal_sessions__crsql_pks')`,
      );
      if (tables.length < 2) return none;
    } catch (error) {
      // A database that cannot answer sqlite_master is a real fault, and the
      // report silently reads every row as this machine's without the clock.
      deps.logger.warn("project_health.owner_site_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return none;
    }
    return {
      select: "max(clock.site_id) as owner_site",
      join: `left join terminal_sessions__crsql_pks pks on pks.id = ts.id
        left join terminal_sessions__crsql_clock clock on clock.key = pks.__crsql_key and clock.col_name = 'owner_pid'`,
    };
  }

  /** Every active lane with its PR, activity, git state and whether it is stale. */
  async function laneHealth(ctx: Context): Promise<{ lanes: ProjectLaneHealth[]; stuckChats: string[]; stuckTerminals: string[] }> {
    const nowMs = Date.now();
    const prs = new Map<string, { pr: NonNullable<ProjectLaneHealth["pr"]>; headSha: string | null }>();
    for (const row of deps.db.all<{ lane_id: string; number: number; state: string; url: string | null; merged_at: string | null; head_sha: string | null }>(
      `select lane_id, github_pr_number as number, state, github_url as url, merged_at, head_sha
         from pull_requests where lane_id is not null order by coalesce(updated_at, created_at) asc`,
    )) {
      // Ascending, so the newest PR for a lane wins.
      prs.set(row.lane_id, { pr: { number: Number(row.number), state: row.state, url: row.url, mergedAt: row.merged_at }, headSha: row.head_sha });
    }
    const activity = new Map<string, string | null>();
    const running = new Map<string, number>();
    const stuckChats: string[] = [];
    const stuckTerminals: string[] = [];
    const label = (row: SessionRow) => `${row.title ?? "Untitled"} (${ctx.lanes.find((lane) => lane.id === row.lane_id)?.name ?? "lane"})`;
    const countRunning = (row: SessionRow) => running.set(row.lane_id, (running.get(row.lane_id) ?? 0) + 1);
    const openChats: SessionRow[] = [];
    const ownerSite = ownerSiteSql();
    for (const row of deps.db.all<SessionRow>(
      `select ts.id, ts.lane_id, ts.tool_type, ts.status, ts.owner_pid, ts.title,
              max(coalesce(ts.last_output_at, ts.ended_at, ts.started_at)) as activity, ${ownerSite.select}
         from terminal_sessions ts ${ownerSite.join}
         where ts.lane_id is not null and ts.archived_at is null group by ts.id`,
    )) {
      activity.set(row.lane_id, latest(activity.get(row.lane_id), row.activity));
      if (row.status !== "running") continue;
      // Another machine's session: its pid and its turn are that machine's.
      if (Number(row.owner_site) > 0) continue;
      if (isChatToolType(row.tool_type)) {
        openChats.push(row);
        continue;
      }
      const pid = Number(row.owner_pid);
      if (Number.isFinite(pid) && pid > 0 && !processAlive(pid)) {
        stuckTerminals.push(label(row));
        continue;
      }
      countRunning(row);
    }
    // A chat is stuck only when the chat service says a turn runs and no
    // runtime holds it. An idle chat is just open.
    const turnStates = new Map<string, ProjectHealthChatTurnState>();
    if (openChats.length && deps.readChatTurnStates) {
      try {
        for (const state of await deps.readChatTurnStates(openChats.map((row) => row.id))) turnStates.set(state.sessionId, state);
      } catch (error) {
        deps.logger.warn("project_health.chat_turn_states_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const row of openChats) {
      const state = turnStates.get(row.id);
      if (state && state.status === "active" && state.runtimeAlive === false && !state.ownedElsewhere) {
        stuckChats.push(label(row));
        continue;
      }
      countRunning(row);
    }
    const staleBefore = nowMs - STALE_AFTER_DAYS * DAY_MS;
    const lanes = await mapLimit(ctx.lanes, GIT_CONCURRENCY, async (lane): Promise<ProjectLaneHealth> => {
      const folderExists = Boolean(lane.worktreePath) && exists(lane.worktreePath);
      const primary = lane.laneType === "primary";
      const git = folderExists ? await laneGitState(lane.worktreePath) : { dirty: null, changedFileCount: null, unpushedCommits: null };
      const prRecord = primary ? null : prs.get(lane.id) ?? null;
      const pr = prRecord?.pr ?? null;
      // A squash-merged PR's branch is usually deleted from the remote, so its
      // commits are on no remote branch; they are still safe when nothing was
      // committed after the PR's head.
      if (pr?.state === "merged" && git.unpushedCommits && prRecord?.headSha) {
        const head = (await gitOutput(lane.worktreePath, ["rev-parse", "HEAD"]))?.trim();
        if (head === prRecord.headSha) git.unpushedCommits = 0;
      }
      const lastActivityAt = latest(activity.get(lane.id), lane.createdAt, lane.lastCommitAt);
      const runningSessions = running.get(lane.id) ?? 0;
      let stale: ProjectLaneStaleReason | null = null;
      if (!primary) {
        if (pr?.state === "merged") stale = "pr-merged";
        else if (pr?.state === "closed") stale = "pr-closed";
        else if (pr?.state !== "open" && lastActivityAt && Date.parse(lastActivityAt) < staleBefore) stale = "idle";
      }
      return {
        laneId: lane.id,
        name: lane.name,
        laneType: lane.laneType,
        worktreePath: lane.worktreePath,
        branch: lane.branchRef || null,
        folderExists,
        pr,
        lastActivityAt,
        ...git,
        runningSessions,
        stale,
        // Git only. The archive stops running chats after confirmation, so
        // bulk archive checks each lane's reclaim risk right before acting.
        safeToArchive: !primary && (!folderExists || (git.dirty === false && git.unpushedCommits === 0)),
      };
    });
    lanes.sort((a, b) => {
      if (a.laneType === "primary") return -1;
      if (b.laneType === "primary") return 1;
      return Date.parse(b.lastActivityAt ?? "0") - Date.parse(a.lastActivityAt ?? "0");
    });
    return { lanes, stuckChats, stuckTerminals };
  }

  async function buildReport(): Promise<ProjectHealthReport> {
    const ctx = await context();
    const issues: ProjectHealthIssue[] = [];
    const checks: ProjectHealthReport["checks"] = [];
    const laneReport = await laneHealth(ctx).catch((error) => {
      deps.logger.warn("project_health.lanes_failed", { error: error instanceof Error ? error.message : String(error) });
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({ id: "lanes", label: "Lanes", ok: false });
      issues.push({ id: "lanes-failed", area: "git", severity: "warning", title: "ADE couldn't check lanes", detail });
      return null;
    });
    const run = async (id: string, label: string, check: () => Promise<ProjectHealthIssue[]> | ProjectHealthIssue[]) => {
      try {
        const found = await check();
        issues.push(...found);
        checks.push({ id, label, ok: !found.some((issue) => issue.severity !== "info") });
      } catch (error) {
        deps.logger.warn("project_health.check_failed", { check: id, error: error instanceof Error ? error.message : String(error) });
        checks.push({ id, label, ok: false });
        issues.push({ id: `${id}-failed`, area: "location", severity: "warning", title: `ADE couldn't check: ${label}`, detail: error instanceof Error ? error.message : String(error) });
      }
    };
    const moved = ctx.previousRoots.length > 0;
    const oldRoot = ctx.previousRoots[0] ?? "";

    await Promise.all([
      run("stale-paths", "ADE's data points inside the project", () => {
        if (!moved) return [];
        const counts = countPathsNaming(rewriteDb(deps.db), ctx.previousSpellings);
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        if (!total) return [];
        return [{
          id: "stale-paths",
          area: "location",
          severity: "problem",
          title: `${plural(total, "saved path")} still name${total === 1 ? "s" : ""} the old folder`,
          detail: `ADE looks for these at ${oldRoot}, which is gone or no longer this project: proof files can't be recovered and lanes can look missing.`,
          items: Object.entries(counts).map(([where, n]) => `${where}: ${n}`),
          fix: { id: "update-paths", label: "Update paths", description: `Points every saved path at ${projectRoot}. Synced to your other devices like any edit.`, kind: "change" },
        }];
      }),
      ...(laneReport ? [run("stale-lanes", "No stale lanes", () => {
        const stale = laneReport.lanes.filter((lane) => lane.stale);
        if (!stale.length) return [];
        const safe = stale.filter((lane) => lane.safeToArchive).length;
        const why = (lane: ProjectLaneHealth) => lane.stale === "pr-merged" ? `PR #${lane.pr?.number} merged`
          : lane.stale === "pr-closed" ? `PR #${lane.pr?.number} closed`
          : `idle since ${lane.lastActivityAt?.slice(0, 10) ?? "?"}`;
        return [{
          id: "stale-lanes",
          area: "git",
          severity: "info",
          title: `${plural(stale.length, "lane")} look${stale.length === 1 ? "s" : ""} done`,
          detail: `Their PR is merged or closed, or nothing happened in them for ${STALE_AFTER_DAYS} days. ${safe === stale.length ? "All can be archived without losing anything." : `${safe} can be archived without losing anything; the rest have changes or unpushed commits.`}`,
          items: stale.map((lane) => `${lane.name}: ${why(lane)}${lane.safeToArchive ? "" : " (has unsaved work)"}`),
        }];
      })] : []),
      ...(laneReport ? [run("stuck-sessions", "No chats or terminals stuck as running", () => {
        const { stuckChats, stuckTerminals } = laneReport;
        const total = stuckChats.length + stuckTerminals.length;
        if (!total) return [];
        const counts = [
          ...(stuckChats.length ? [plural(stuckChats.length, "chat")] : []),
          ...(stuckTerminals.length ? [plural(stuckTerminals.length, "terminal")] : []),
        ].join(" and ");
        return [{
          id: "stuck-sessions",
          area: "agents",
          severity: "warning",
          title: `${counts} still show${total === 1 ? "s" : ""} as running`,
          detail: "The process that ran them is gone, so they will never finish on their own. Open each and stop or resume it.",
          items: [
            ...stuckChats.map((item) => `Chat: ${item}`),
            ...stuckTerminals.map((item) => `Terminal: ${item}`),
          ],
        }];
      })] : []),
      run("git-leftovers", "No git leftovers", () => {
        if (!exists(path.join(projectRoot, ".git"))) return [];
        const leftovers = gitLeftovers(projectRoot, Date.now());
        if (!leftovers.length) return [];
        return [{
          id: "git-leftovers",
          area: "git",
          severity: "warning",
          title: `Git was interrupted in ${plural(leftovers.length, "place")}`,
          detail: "A lock file makes every git command in that checkout fail; a stopped rebase or merge leaves files half-changed. Finish or abort it there, or remove the lock if no git is running.",
          items: leftovers,
        }];
      }),
      run("lane-folders", "Every lane's folder exists", () => {
        const missing = ctx.lanes.filter((lane) => lane.laneType !== "primary" && lane.worktreePath && !exists(lane.worktreePath));
        if (!missing.length) return [];
        return [{
          id: "lane-folders",
          area: "git",
          severity: "problem",
          title: `${plural(missing.length, "lane")} ${missing.length === 1 ? "has" : "have"} no folder`,
          detail: "Chats in these lanes can't run, and git can't see their work. Restore the folder, or archive the lane if it's done.",
          items: missing.map((lane) => `${lane.name}: ${lane.worktreePath}`),
        }];
      }),
      run("git-links", "Lanes are linked to this repository", () => {
        if (!exists(path.join(projectRoot, ".git"))) return [];
        const broken = ctx.checkouts
          .filter((checkout) => !checkout.primary)
          .flatMap((checkout) => {
            const problem = laneLinkProblem(projectRoot, checkout.root);
            return problem ? [`${checkout.label} ${problem}`] : [];
          });
        if (!broken.length) return [];
        return [{
          id: "git-links",
          area: "git",
          severity: "problem",
          title: `${plural(broken.length, "lane")} ${broken.length === 1 ? "isn't" : "aren't"} linked to this repository`,
          detail: "Git in these lanes works on another copy of the repository, or not at all: commits can land in the wrong place.",
          items: broken,
          ...(moved ? { fix: { id: "relink-lanes", label: "Relink lanes", description: "Rewrites each lane's git link to this repository, as the move does. No commits or files change.", kind: "change" as const } } : {}),
        }];
      }),
      run("symlinks", "Links point inside the project", async () => {
        const links = await symlinksNamingOldRoot(ctx);
        if (!links.length) return [];
        return [{
          id: "symlinks",
          area: "location",
          severity: "warning",
          title: `${plural(links.length, "link")} still point${links.length === 1 ? "s" : ""} at the old folder`,
          detail: "Tools that follow them read the old copy, or nothing once it is deleted.",
          items: links.map((link) => path.relative(projectRoot, link)),
          fix: { id: "relink-symlinks", label: "Repoint links", description: `Points each link at the same place under ${projectRoot}.`, kind: "change" },
        }];
      }),
      run("dependencies", "Dependencies are installed", () => {
        const plan = dependencyPlan(ctx, deps.logger);
        if (!plan.installs.length && !plan.brokenLinks.length) return [];
        return [{
          id: "dependencies",
          area: "dependencies",
          severity: "warning",
          title: plan.installs.length
            ? `${plural(plan.installs.length, "checkout")} need${plan.installs.length === 1 ? "s" : ""} dependencies installed`
            : `${plural(plan.brokenLinks.length, "dependency link")} point${plan.brokenLinks.length === 1 ? "s" : ""} at nothing`,
          detail: "Builds, tests and dev servers in the main checkout fail until dependencies are installed. Older lanes that link to the main checkout's dependencies work again once it is installed.",
          items: [
            ...plan.installs.map((install) => `${install.checkout.label}: ${install.command}`),
            ...plan.brokenLinks.map((link) => `broken link: ${path.relative(projectRoot, link)}`),
          ],
          ...(plan.installs.length && deps.openTerminal
            ? { fix: { id: "install-dependencies", label: "Install", description: `Opens a terminal per checkout and runs its install there, where you can watch it: ${plan.installs.map((install) => install.command).join("; ")}.`, kind: "terminal" as const } }
            : {}),
        }];
      }),
      run("virtualenvs", "Python virtualenvs match their folder", () => {
        const venvs = ctx.checkouts.flatMap((checkout) => movedVirtualenvs(checkout.root));
        if (!venvs.length) return [];
        return [{
          id: "virtualenvs",
          area: "dependencies",
          severity: "warning",
          title: `${plural(venvs.length, "Python virtualenv")} ${venvs.length === 1 ? "was" : "were"} made for another folder`,
          detail: "Their scripts (python, pip, installed tools) still point at the folder they were created in. Recreate them, e.g. `uv venv` and reinstall.",
          items: venvs.map((venv) => path.relative(projectRoot, venv)),
        }];
      }),
      run("agent-trust", "Agents trust this folder", () => {
        if (!moved) return [];
        const args = { oldSpellings: ctx.previousSpellings, newRoot: projectRoot, dryRun: true };
        const missing = [
          ...(carryClaudeProjectSettings(args) ? ["Claude Code"] : []),
          ...(carryCodexTrust(args) ? ["Codex"] : []),
          ...(carryCopilotTrust(args) ? ["GitHub Copilot"] : []),
        ];
        if (!missing.length) return [];
        return [{
          id: "agent-trust",
          area: "agents",
          severity: "warning",
          title: `${missing.join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} trust the new folder yet`,
          detail: "They trusted the old folder. Here they ask again, and Claude forgets the tools and MCP servers you allowed.",
          items: missing,
          fix: { id: "carry-trust", label: "Carry trust over", description: "Copies each tool's settings for the old folder to this one. The old entries stay.", kind: "change" },
        }];
      }),
      run("agent-history", "Agent history is filed under this folder", () => {
        const plans = historyPlans(ctx);
        if (!plans.length) return [];
        return [{
          id: "agent-history",
          area: "agents",
          severity: "warning",
          title: `${plural(plans.length, "chat history folder")} ${plans.length === 1 ? "is" : "are"} still under the old path`,
          detail: "Those tools look for this project's history under the new path, so old chats don't resume.",
          items: [...new Set(plans.map((plan) => `${plan.label}: ${path.basename(plan.from)}`))],
          fix: { id: "move-history", label: "Move history", description: "Renames each folder to the new path's name. Nothing inside is edited, and nothing is overwritten.", kind: "change" },
        }];
      }),
      run("simulators", "Lane simulators know this folder", () => {
        const stale = staleSimulatorMarkers(ctx);
        if (!stale) return [];
        return [{
          id: "simulators",
          area: "apple",
          severity: "warning",
          title: `${plural(stale, "lane simulator")} still name${stale === 1 ? "s" : ""} the old folder`,
          detail: "ADE treats them as left over from a deleted project and may offer to remove them.",
          fix: { id: "repoint-simulators", label: "Update simulators", description: "Records the new folder in each lane simulator.", kind: "change" },
        }];
      }),
      run("mentions", "Files don't name the old folder", async () => {
        if (!moved) return [];
        const files = await filesMentioningPath(ctx.checkouts.map((checkout) => checkout.root), projectRoot, ctx.previousSpellings);
        if (!files.length) return [];
        return [{
          id: "mentions",
          area: "location",
          severity: "info",
          title: `${plural(files.length, "file")} name${files.length === 1 ? "s" : ""} the old folder`,
          detail: "Scripts and settings with the old path run in the wrong place or fail. ADE doesn't edit your files; an agent can go through them with you.",
          items: files,
        }];
      }),
      run("old-copy", "No old copy left behind", () => {
        const kept = listMoveRecords().filter((record) =>
          record.state === "done"
          && record.destinationRoot === projectRoot
          && record.originalParkedAt
          && record.cleanup.choice !== "deleted"
          && exists(record.originalParkedAt));
        return kept.map((record) => ({
          id: `old-copy-${record.moveId}`,
          area: "storage" as const,
          severity: "info" as const,
          title: `The old copy is still at ${record.originalParkedAt}`,
          detail: `${record.originalBytes ? `${formatBytes(record.originalBytes)} you can free. ` : ""}Delete it from Settings → Location once the project works here.`,
        }));
      }),
      run("drive", "The drive is the one ADE expects", async () => {
        const volume = await readMoveVolume(projectRoot);
        if (!volume || volume.internal) return [];
        const found: ProjectHealthIssue[] = [];
        const expected = listMoveRecords().find((record) => record.state === "done" && record.destinationRoot === projectRoot)?.destinationVolumeUuid;
        if (expected && volume.uuid && expected !== volume.uuid) {
          found.push({
            id: "drive-replaced",
            area: "drive",
            severity: "problem",
            title: `${volume.name} isn't the drive this project was moved to`,
            detail: "A different drive is mounted under the same name. Eject it and connect the drive the project lives on.",
          });
        }
        if ((await timeMachineBacksUp(volume.mountPath)) === false) {
          found.push({
            id: "drive-backup",
            area: "drive",
            severity: "info",
            title: `Time Machine doesn't back up ${volume.name}`,
            detail: "Pushed branches are safe on your git host, but unpushed work, ADE's chats and proof on this drive have no backup.",
          });
        }
        return found;
      }),
    ]);

    const order = { problem: 0, warning: 1, info: 2 } as const;
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    const volume = await readMoveVolume(projectRoot).catch(() => null);
    return {
      projectRoot,
      checkedAt: new Date().toISOString(),
      previousRoots: ctx.previousRoots,
      drive: volume ? { name: volume.name, internal: volume.internal, freeBytes: volume.freeBytes, totalBytes: volume.totalBytes } : null,
      issues,
      lanes: laneReport?.lanes ?? [],
      staleAfterDays: STALE_AFTER_DAYS,
      checks: checks.sort((a, b) => a.label.localeCompare(b.label)),
    };
  }

  async function getReport(args: { forceRefresh?: boolean } = {}): Promise<ProjectHealthReport> {
    if (!args.forceRefresh && cached && Date.now() - cached.at < REPORT_CACHE_MS) return cached.report;
    const report = buildReport();
    cached = { at: Date.now(), report };
    report.catch(() => {
      if (cached?.report === report) cached = null;
    });
    return report;
  }

  async function fix(args: { fixId: string }): Promise<ProjectHealthFixResult> {
    const ctx = await context();
    const done: string[] = [];
    const problems: string[] = [];
    const needsMove = () => {
      if (!ctx.previousSpellings.length) throw new Error("ADE has no record of where this project lived before, so it can't tell which paths are stale.");
    };
    try {
      switch (args.fixId) {
        case "update-paths": {
          needsMove();
          deps.db.run("begin immediate");
          let changed: number;
          try {
            changed = rewritePathsInDatabase(rewriteDb(deps.db), ctx.previousSpellings, projectRoot, { keepExisting: true });
            deps.db.run("commit");
          } catch (error) {
            deps.db.run("rollback");
            throw error;
          }
          rewriteAdeJsonFiles(projectRoot, ctx.previousSpellings, projectRoot);
          done.push(`Updated ${plural(changed, "saved path")}.`);
          break;
        }
        case "relink-lanes": {
          needsMove();
          const links = rewriteWorktreeLinksInCopy({ copyRoot: projectRoot, finalRoot: projectRoot, oldSpellings: ctx.previousSpellings });
          done.push(`Relinked ${plural(links.inside.length, "lane")}.`);
          problems.push(...links.outside.map((lane) => `${lane.name} is outside the project folder, so ADE left its link alone.`));
          problems.push(...links.missing.map((lane) => `${lane.name}'s folder is missing.`));
          break;
        }
        case "relink-symlinks": {
          needsMove();
          const count = await relinkAbsoluteSymlinks({ copyRoot: projectRoot, finalRoot: projectRoot, oldSpellings: ctx.previousSpellings });
          done.push(`Repointed ${plural(count, "link")}.`);
          break;
        }
        case "carry-trust": {
          needsMove();
          const trustArgs = { oldSpellings: ctx.previousSpellings, newRoot: projectRoot };
          if (carryClaudeProjectSettings(trustArgs)) done.push("Claude Code trusts this folder and keeps its allowed tools.");
          if (carryCodexTrust(trustArgs)) done.push("Codex trusts this folder.");
          if (carryCopilotTrust(trustArgs)) done.push("GitHub Copilot trusts this folder.");
          break;
        }
        case "move-history": {
          needsMove();
          const result = applyAgentHistoryRenames(historyPlans(ctx));
          done.push(`Moved ${plural(result.moved, "history folder")}.`);
          problems.push(...result.problems);
          break;
        }
        case "repoint-simulators": {
          needsMove();
          const changed = ctx.previousRoots.reduce((sum, previous) => sum + rewriteSimulatorMarkers(rootSpellings(previous), projectRoot), 0);
          done.push(`Updated ${plural(changed, "lane simulator")}.`);
          break;
        }
        case "install-dependencies": {
          if (!deps.openTerminal) throw new Error("Terminals aren't available here.");
          for (const install of dependencyPlan(ctx, deps.logger).installs) {
            await deps.openTerminal({ laneId: install.checkout.laneId, cwd: install.checkout.root, title: "Install dependencies", command: install.command });
            done.push(`Started \`${install.command}\` in ${install.checkout.label}.`);
          }
          break;
        }
        default:
          throw new Error(`Unknown fix: ${args.fixId}`);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    deps.logger.info("project_health.fix", { fixId: args.fixId, done: done.length, problems: problems.length });
    cached = null;
    return { ok: problems.length === 0, done, problems, report: await getReport({ forceRefresh: true }) };
  }

  return { getReport, fix };
}

export type ProjectHealthService = ReturnType<typeof createProjectHealthService>;
