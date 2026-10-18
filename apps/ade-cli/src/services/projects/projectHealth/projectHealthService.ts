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
} from "../../../../../desktop/src/shared/types/projectHealth";
import { formatBytes } from "../../../../../desktop/src/shared/formatting";
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
import { listMoveRecords, previousProjectRoots } from "../projectMove/moveJournal";
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
  db: Pick<AdeDb, "all" | "runChanged">;
  logger: Pick<Logger, "info" | "warn">;
  listLanes: () => Promise<LaneSummary[]>;
  /** Opens a terminal in the lane and runs the command, so the person sees it. */
  openTerminal?: (request: ProjectHealthTerminalRequest) => Promise<void>;
};

const REPORT_CACHE_MS = 30_000;
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

function hasPackageInstall(root: string): boolean {
  return exists(path.join(root, "package.json")) && lockfileKind(root) !== null;
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
function installUnits(checkoutRoot: string): string[] {
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
  return units.filter(hasPackageInstall);
}

type DependencyInstall = { checkout: Checkout; command: string };

/**
 * What to install where. A unit with no `node_modules` needs an install in its
 * checkout. A lane whose `node_modules` is a link into the main checkout is
 * fixed by installing the main checkout, never by installing the lane (that
 * would replace a shared link with gigabytes of copies). Links to anywhere
 * else that is gone are reported as broken.
 */
function dependencyPlan(ctx: Context): { installs: DependencyInstall[]; brokenLinks: string[] } {
  const primary = ctx.checkouts.find((checkout) => checkout.primary) ?? null;
  const needs = new Map<Checkout, Set<string>>();
  const brokenLinks: string[] = [];
  const mark = (checkout: Checkout, unit: string) => {
    if (!needs.has(checkout)) needs.set(checkout, new Set());
    needs.get(checkout)!.add(unit);
  };
  for (const checkout of ctx.checkouts) {
    for (const unit of installUnits(checkout.root)) {
      const nodeModules = path.join(unit, "node_modules");
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(nodeModules);
      } catch {
        stat = null;
      }
      const empty = stat?.isDirectory() === true && isEmptyDir(nodeModules);
      if (!stat || empty) {
        // A lane often installs only some of its packages, or shares them by
        // link; only its own top-level install is expected.
        if (checkout.primary || unit === checkout.root) mark(checkout, unit);
        continue;
      }
      if (!stat.isSymbolicLink() || exists(nodeModules)) continue;
      let target = "";
      try {
        target = path.resolve(unit, fs.readlinkSync(nodeModules));
      } catch {
        // unreadable link
      }
      if (primary && target && path.dirname(target).startsWith(primary.root) && !path.dirname(target).startsWith(path.join(primary.root, ".ade"))) {
        mark(primary, path.dirname(target));
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

  async function buildReport(): Promise<ProjectHealthReport> {
    const ctx = await context();
    const issues: ProjectHealthIssue[] = [];
    const checks: ProjectHealthReport["checks"] = [];
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
        const plan = dependencyPlan(ctx);
        if (!plan.installs.length && !plan.brokenLinks.length) return [];
        return [{
          id: "dependencies",
          area: "dependencies",
          severity: "warning",
          title: plan.installs.length
            ? `${plural(plan.installs.length, "checkout")} need${plan.installs.length === 1 ? "s" : ""} dependencies installed`
            : `${plural(plan.brokenLinks.length, "dependency link")} point${plan.brokenLinks.length === 1 ? "s" : ""} at nothing`,
          detail: "Builds, tests and dev servers fail until dependencies are installed. Lanes that share the main checkout's dependencies work again once it is installed, so they aren't reinstalled one by one.",
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
          detail: `${record.originalBytes ? `${formatBytes(record.originalBytes)} you can free. ` : ""}Delete it from Settings → Project location once the project works here.`,
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
          const changed = rewritePathsInDatabase(rewriteDb(deps.db), ctx.previousSpellings, projectRoot);
          rewriteAdeJsonFiles(projectRoot, ctx.previousSpellings, projectRoot);
          done.push(`Updated ${plural(changed, "saved path")}.`);
          break;
        }
        case "relink-lanes": {
          needsMove();
          const links = rewriteWorktreeLinksInCopy({ copyRoot: projectRoot, finalRoot: projectRoot, oldSpellings: ctx.previousSpellings });
          done.push(`Relinked ${plural(links.inside.length, "lane")}.`);
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
          for (const install of dependencyPlan(ctx).installs) {
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
