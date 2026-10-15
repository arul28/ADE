import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ProjectMoveCheck,
  ProjectMoveNote,
  ProjectMovePreflight,
  ProjectMoveVolume,
} from "../../../../../desktop/src/shared/types/projectMove";
import { detectCloudStorageProvider } from "../../../../../desktop/src/main/services/storage/cloudPlaceholder";
import { planAgentHistoryRenames, summarizeAgentHistory } from "./moveAgentHistory";
import { measureProject } from "./moveCopy";
import { projectDatabasePath, readProjectDatabaseSummary } from "./moveDatabase";
import { listWorktreeLinks, rootSpellings } from "./moveGitLinks";
import { ownsLeftoverCopy } from "./moveJournal";
import { nearestExistingDir, readMoveVolume } from "./moveVolumes";

const execFileAsync = promisify(execFile);

/** macOS refuses a unix socket path longer than this; the project's lives at `<root>/.ade/ade.sock`. */
const MAX_SOCKET_PATH_BYTES = 103;
/** Room left on the destination beyond the copy itself. */
const SPACE_MARGIN_BYTES = 2 * 1024 ** 3;
/** Git learned relative worktree links in 2.48. */
const MIN_GIT = [2, 48] as const;
const NETWORK_FILE_SYSTEMS = new Set(["smbfs", "nfs", "afpfs", "webdav", "cifs", "ftp"]);

/** What is running in the project, supplied by whoever owns the project's sessions. */
export type ProjectActivity = {
  /** Agent turns in progress. They block the move. */
  runningChats: string[];
  /** Open terminals and running processes. They are closed by the move. */
  openTerminals: string[];
};

export function finalDestination(destinationParent: string, projectName: string): string {
  return path.join(path.resolve(destinationParent), projectName);
}

export function copyLocation(destinationRoot: string): string {
  return `${destinationRoot}.ade-moving`;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function gitVersion(): Promise<[number, number] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 10_000 });
    const match = stdout.match(/(\d+)\.(\d+)/u);
    return match ? [Number(match[1]), Number(match[2])] : null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Git busy in a checkout: another git command holds its index. */
function gitBusyIn(adminDir: string): boolean {
  return fs.existsSync(path.join(adminDir, "index.lock"));
}

/** An operation git is in the middle of: it carries over to the copy, but worth saying. */
function gitOperationIn(adminDir: string): string | null {
  if (fs.existsSync(path.join(adminDir, "rebase-merge")) || fs.existsSync(path.join(adminDir, "rebase-apply"))) return "a rebase";
  if (fs.existsSync(path.join(adminDir, "MERGE_HEAD"))) return "a merge";
  if (fs.existsSync(path.join(adminDir, "CHERRY_PICK_HEAD"))) return "a cherry-pick";
  if (fs.existsSync(path.join(adminDir, "REVERT_HEAD"))) return "a revert";
  return null;
}

/** Files at the top of the project and each lane that mention the old path. */
function filesMentioningPath(checkouts: string[], oldSpellings: string[]): string[] {
  const names = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", path.join(".claude", "settings.json"), path.join(".claude", "settings.local.json")];
  const found: string[] = [];
  for (const checkout of checkouts) {
    for (const name of names) {
      const file = path.join(checkout, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const text = fs.readFileSync(file, "utf8");
        if (oldSpellings.some((spelling) => text.includes(spelling))) found.push(file);
      } catch {
        // missing
      }
    }
  }
  return found;
}

function hasPythonEnvironment(checkouts: string[]): boolean {
  return checkouts.some((checkout) =>
    [".venv", "venv", "env"].some((name) => fs.existsSync(path.join(checkout, name, "pyvenv.cfg"))),
  );
}

function lockfileKind(root: string): "pnpm" | "npm" | "yarn" | "bun" | null {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  return null;
}

/**
 * Everything checked before a move starts. Nothing here changes the project:
 * the database is read without locks and git metadata is read as files. The
 * one write is a probe file at the destination, which is also what makes
 * macOS ask for access to an external drive now rather than halfway through.
 */
export async function preflightProjectMove(args: {
  sourceRoot: string;
  destinationRoot: string;
  activity: ProjectActivity;
}): Promise<ProjectMovePreflight> {
  const sourceRoot = path.resolve(args.sourceRoot);
  const destinationRoot = path.resolve(args.destinationRoot);
  const projectName = path.basename(sourceRoot);
  const oldSpellings = rootSpellings(sourceRoot);
  const checks: ProjectMoveCheck[] = [];
  const notes: ProjectMoveNote[] = [];

  if (!fs.existsSync(sourceRoot)) {
    return {
      projectName,
      sourceRoot,
      destinationRoot,
      sourceVolume: null,
      destinationVolume: null,
      copyBytes: 0,
      dependencyBytes: 0,
      laneCount: 0,
      checks: [{ id: "destination", status: "blocked", title: `The project isn't at ${sourceRoot}`, detail: "Connect its drive, or open it where it is now." }],
      canMove: false,
      notes: [],
      agentHistory: [],
    };
  }

  const [sourceVolume, destinationVolume, sizes, git] = await Promise.all([
    readMoveVolume(sourceRoot),
    readMoveVolume(destinationRoot),
    measureProject(sourceRoot),
    gitVersion(),
  ]);

  // Where it goes.
  const destinationProblems: string[] = [];
  if (process.platform !== "darwin") destinationProblems.push("Moving a project is only available on macOS for now.");
  if (isInside(destinationRoot, sourceRoot)) destinationProblems.push("The new location is inside the project itself.");
  else if (isInside(sourceRoot, destinationRoot)) destinationProblems.push("The project is inside the new location.");
  if (fs.existsSync(destinationRoot)) destinationProblems.push(`There is already a folder at ${destinationRoot}. Pick another place or name.`);
  if (fs.existsSync(copyLocation(destinationRoot)) && !ownsLeftoverCopy(destinationRoot)) {
    destinationProblems.push(`A folder from an earlier attempt is at ${copyLocation(destinationRoot)}. Delete it, then try again.`);
  }
  const socketBytes = Buffer.byteLength(path.join(destinationRoot, ".ade", "ade.sock"));
  if (socketBytes > MAX_SOCKET_PATH_BYTES) destinationProblems.push("That path is too long for ADE's project connection. Pick a shorter folder.");
  if (detectCloudStorageProvider(destinationRoot)) destinationProblems.push("That folder is synced by a cloud service, which can evict files ADE needs. Pick a local folder.");
  checks.push(destinationProblems.length
    ? { id: "destination", status: "blocked", title: "The new location can't be used", detail: destinationProblems.join(" ") }
    : { id: "destination", status: "ok", title: `New location: ${destinationRoot}` });

  // The drive.
  checks.push(driveCheck(sourceVolume, destinationVolume));

  // Space.
  const needed = sizes.copyBytes + SPACE_MARGIN_BYTES;
  const free = destinationVolume?.freeBytes ?? 0;
  const where = destinationVolume?.name ?? "the new location";
  if (free < needed) {
    checks.push({
      id: "space",
      status: "blocked",
      title: `Not enough space on ${where}`,
      detail: `The project needs about ${formatBytes(needed)} and ${where} has ${formatBytes(free)} free.`,
    });
  } else if (free < needed + sizes.dependencyBytes) {
    checks.push({
      id: "space",
      status: "warning",
      title: `Enough space to move, tight for reinstalling dependencies`,
      detail: `Moving needs ${formatBytes(sizes.copyBytes)}; reinstalling dependencies later needs about ${formatBytes(sizes.dependencyBytes)} more.`,
    });
  } else {
    checks.push({ id: "space", status: "ok", title: `Enough space on ${where}`, detail: `${formatBytes(sizes.copyBytes)} to copy, ${formatBytes(free)} free.` });
  }

  // Access: write and remove a probe where the copy will go.
  checks.push(accessCheck(destinationRoot, where));

  // Nothing running.
  if (args.activity.runningChats.length) {
    checks.push({
      id: "quiet",
      status: "blocked",
      title: "Agents are working in this project",
      detail: "Wait for them to finish, or stop them, then check again.",
      items: args.activity.runningChats,
    });
  } else if (args.activity.openTerminals.length) {
    checks.push({
      id: "quiet",
      status: "warning",
      title: "Open terminals will close",
      detail: "The move closes the project, which ends these. Chats are kept.",
      items: args.activity.openTerminals,
    });
  } else {
    checks.push({ id: "quiet", status: "ok", title: "Nothing is running in the project" });
  }

  // Git.
  const gitProblems: string[] = [];
  const gitWarnings: string[] = [];
  const gitDir = path.join(sourceRoot, ".git");
  let isMainCheckout = false;
  try {
    isMainCheckout = fs.statSync(gitDir).isDirectory();
  } catch {
    isMainCheckout = false;
  }
  if (!isMainCheckout) gitProblems.push("This project is itself a lane of another repository, so ADE can't move it on its own.");
  if (!git) gitProblems.push("ADE couldn't run git.");
  else if (git[0] < MIN_GIT[0] || (git[0] === MIN_GIT[0] && git[1] < MIN_GIT[1])) {
    gitProblems.push(`Git ${git.join(".")} is too old. Update to git ${MIN_GIT.join(".")} or later.`);
  }
  const links = isMainCheckout ? listWorktreeLinks(sourceRoot, oldSpellings) : [];
  const busy: string[] = [];
  const operations: string[] = [];
  if (isMainCheckout) {
    if (gitBusyIn(gitDir)) busy.push(projectName);
    const op = gitOperationIn(gitDir);
    if (op) operations.push(`${projectName} (${op})`);
    for (const link of links) {
      const adminDir = path.join(gitDir, "worktrees", link.name);
      const label = link.relativePath ? path.basename(link.relativePath) : link.lanePath;
      if (gitBusyIn(adminDir)) busy.push(label);
      const laneOp = gitOperationIn(adminDir);
      if (laneOp) operations.push(`${label} (${laneOp})`);
    }
  }
  if (busy.length) gitProblems.push(`Git is busy in ${busy.join(", ")}. Wait for it to finish.`);
  if (operations.length) gitWarnings.push(`In progress, and carried over as-is: ${operations.join(", ")}.`);
  checks.push(gitProblems.length
    ? { id: "git", status: "blocked", title: "Git isn't ready", detail: gitProblems.join(" ") }
    : gitWarnings.length
      ? { id: "git", status: "warning", title: "Git is ready", detail: gitWarnings.join(" ") }
      : { id: "git", status: "ok", title: "Git is ready" });

  // Lanes.
  let laneCount = 0;
  let knownLanePaths: string[] = [];
  try {
    const summary = readProjectDatabaseSummary(projectDatabasePath(sourceRoot));
    laneCount = summary.lanes.filter((lane) => lane.status !== "archived" && lane.laneType !== "primary").length;
    knownLanePaths = summary.lanes.map((lane) => lane.worktreePath).filter(Boolean);
    if (summary.projectCount !== 1) {
      checks.push({ id: "lanes", status: "blocked", title: "ADE's data for this project needs a repair first", detail: `It lists ${summary.projectCount} projects instead of one.` });
    }
  } catch {
    checks.push({ id: "lanes", status: "blocked", title: "ADE couldn't read this project's data", detail: "Open the project once so ADE can check it, then try again." });
  }
  if (!checks.some((check) => check.id === "lanes")) {
    const outside = links.filter((link) => link.relativePath === null && link.exists);
    checks.push(outside.length
      ? {
          id: "lanes",
          status: "warning",
          title: `${outside.length === 1 ? "1 lane lives" : `${outside.length} lanes live`} outside the project`,
          detail: "Not copied. ADE links it to the moved project.",
          items: outside.map((link) => link.lanePath),
        }
      : { id: "lanes", status: "ok", title: `${laneCount} lane${laneCount === 1 ? "" : "s"} move with the project` });
  }

  // What ADE leaves for the person.
  const checkouts = [sourceRoot, ...links.filter((link) => link.relativePath !== null && link.exists).map((link) => path.join(sourceRoot, link.relativePath!))];
  const lockfile = lockfileKind(sourceRoot);
  if (sizes.dependencyBytes > 0 || lockfile) {
    notes.push({
      id: "dependencies",
      title: `Run ${lockfile ? `${lockfile} install` : "your install command"}`,
      detail: `${formatBytes(sizes.dependencyBytes)} of dependencies are reinstalled, not copied.`,
    });
  }
  const mentions = filesMentioningPath(checkouts, oldSpellings);
  if (mentions.length) {
    notes.push({
      id: "mentions",
      title: `Update the old path in ${mentions.map((file) => path.basename(file)).filter((name, i, all) => all.indexOf(name) === i).join(", ")}`,
      detail: mentions.map((file) => path.relative(sourceRoot, file)).join("\n"),
    });
  }
  if (hasPythonEnvironment(checkouts)) {
    notes.push({ id: "python", title: "Recreate Python virtual environments", detail: "A virtualenv records its own folder." });
  }

  const agentHistory = summarizeAgentHistory(
    planAgentHistoryRenames({
      oldSpellings,
      newRoot: destinationRoot,
      knownPaths: [sourceRoot, ...knownLanePaths],
    }),
    { oldSpellings },
  );

  return {
    projectName,
    sourceRoot,
    destinationRoot,
    sourceVolume,
    destinationVolume,
    copyBytes: sizes.copyBytes,
    dependencyBytes: sizes.dependencyBytes,
    laneCount,
    checks,
    canMove: !checks.some((check) => check.status === "blocked"),
    notes,
    agentHistory,
  };
}

function driveCheck(source: ProjectMoveVolume | null, destination: ProjectMoveVolume | null): ProjectMoveCheck {
  if (!destination) return { id: "drive", status: "blocked", title: "ADE couldn't read the new location's drive", detail: "Check that the drive is connected." };
  if (NETWORK_FILE_SYSTEMS.has(destination.fileSystem)) {
    return { id: "drive", status: "blocked", title: `${destination.name} is a network drive`, detail: "Projects need a local drive: git and ADE's database are not safe over a network share." };
  }
  if (destination.fileSystem && destination.fileSystem !== "apfs" && destination.fileSystem !== "hfs") {
    return { id: "drive", status: "blocked", title: `${destination.name} isn't formatted for a Mac`, detail: `It uses ${destination.fileSystem}, which loses permissions git needs. Format it as APFS.` };
  }
  if (source && destination.caseSensitive !== source.caseSensitive) {
    return destination.caseSensitive
      ? { id: "drive", status: "warning", title: `${destination.name} tells apart upper and lower case`, detail: "That's usually fine, but tools that rely on the Mac ignoring case may notice." }
      : { id: "drive", status: "blocked", title: `${destination.name} doesn't tell apart upper and lower case`, detail: "The project may have files whose names differ only by case, and they would overwrite each other." };
  }
  if (source && destination.uuid && destination.uuid === source.uuid) {
    return { id: "drive", status: "ok", title: `Same drive (${destination.name})` };
  }
  return { id: "drive", status: "ok", title: `${destination.internal ? "Internal disk" : destination.name} is ready`, detail: destination.internal ? undefined : "ADE remembers this drive, so it won't use a different drive that later appears under the same name." };
}

function accessCheck(destinationRoot: string, where: string): ProjectMoveCheck {
  const probeDir = nearestExistingDir(path.dirname(destinationRoot));
  const probe = path.join(probeDir, `.ade-move-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return { id: "access", status: "ok", title: `ADE can write to ${where}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      id: "access",
      status: "blocked",
      title: `ADE can't write to ${where}`,
      detail: code === "EPERM"
        ? "macOS is blocking access. Open System Settings → Privacy & Security → Files and Folders, allow ADE to use removable and external volumes, then check again."
        : `Writing to ${probeDir} failed (${code ?? "unknown error"}). Check the folder's permissions.`,
    };
  }
}
