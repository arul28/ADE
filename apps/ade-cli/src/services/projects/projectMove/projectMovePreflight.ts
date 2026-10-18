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
import { formatBytes } from "../../../../../desktop/src/shared/formatting";
import { isPathInside } from "../../../../../desktop/src/main/services/shared/pathCompare";
import { detectCloudStorageProvider } from "../../../../../desktop/src/main/services/storage/cloudPlaceholder";
import { planAgentHistoryRenames, summarizeAgentHistory } from "./moveAgentHistory";
import { measureProject, onSameVolume } from "./moveCopy";
import { projectDatabasePath, readProjectDatabaseSummary, type DatabaseSummary } from "./moveDatabase";
import { listWorktreeLinks, rootSpellings, type WorktreeLink } from "./moveGitLinks";
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
  /** Set when ADE could not find out what is running: the move waits rather than guess. */
  unknownReason?: string;
};

export function copyLocation(destinationRoot: string): string {
  return `${destinationRoot}.ade-moving`;
}

async function gitVersion(): Promise<[number, number] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 10_000 });
    const match = stdout.match(/(\d+)\.(\d+)/u);
    return match ? [Number(match[1]), Number(match[2])] : null;
  } catch {
    return null;
  }
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

/** Untracked files that commonly hold absolute paths; tracked files are found with `git grep`. */
const UNTRACKED_CONFIG_FILES = [
  "CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".mcp.json", ".env", ".env.local", ".envrc",
  path.join(".claude", "settings.json"), path.join(".claude", "settings.local.json"),
  path.join(".vscode", "settings.json"), path.join(".vscode", "launch.json"),
];
const MAX_MENTIONS = 40;

/**
 * Files in the project and its lanes that name the old path: tracked files
 * (scripts, configs, docs) through `git grep`, which reads without locking,
 * plus the untracked config files agents and editors keep. Paths are relative
 * to the project root, one entry per file.
 */
export async function filesMentioningPath(checkouts: string[], sourceRoot: string, oldSpellings: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const checkout of checkouts) {
    if (found.size >= MAX_MENTIONS) break;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["--no-optional-locks", "-C", checkout, "grep", "-l", "-I", "-F", ...oldSpellings.flatMap((spelling) => ["-e", spelling])],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      for (const line of stdout.split("\n")) {
        if (line.trim()) found.add(path.relative(sourceRoot, path.join(checkout, line.trim())));
      }
    } catch {
      // exit 1: no match; anything else: not a git checkout or git busy
    }
    for (const name of UNTRACKED_CONFIG_FILES) {
      const file = path.join(checkout, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const text = fs.readFileSync(file, "utf8");
        if (oldSpellings.some((spelling) => text.includes(spelling))) found.add(path.relative(sourceRoot, file));
      } catch {
        // missing
      }
    }
  }
  return [...found].slice(0, MAX_MENTIONS);
}

/**
 * Lane `node_modules` links that point into a dependency folder of the
 * project. Those folders are reinstalled, not copied, when dependencies are
 * left out, so the links stay broken until that install.
 */
function dependencyLinksIntoProject(checkouts: string[], oldSpellings: string[]): string[] {
  const links: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules" && entry.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(full);
          if (path.isAbsolute(target) && oldSpellings.some((spelling) => target === spelling || target.startsWith(`${spelling}/`))) links.push(full);
        } catch {
          // unreadable link
        }
        continue;
      }
      if (!entry.isDirectory() || depth >= 3) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".ade" || entry.name.startsWith(".")) continue;
      visit(full, depth + 1);
    }
  };
  for (const checkout of checkouts) visit(checkout, 0);
  return links;
}

function hasPythonEnvironment(checkouts: string[]): boolean {
  return checkouts.some((checkout) =>
    [".venv", "venv", "env"].some((name) => fs.existsSync(path.join(checkout, name, "pyvenv.cfg"))),
  );
}

/**
 * The command that installs a checkout's dependencies: the project's own
 * `setup` script when it has one (some repos install several packages from
 * there), else the package manager's install.
 */
export function installCommandFor(root: string): string | null {
  const manager = lockfileKind(root);
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    if (!manager) return null;
  }
  const runner = manager ?? "npm";
  if (typeof scripts.setup === "string") return `${runner} run setup`;
  return manager ? `${manager} install` : null;
}

export function lockfileKind(root: string): "pnpm" | "npm" | "yarn" | "bun" | null {
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
  const base = { projectName, sourceRoot, destinationRoot };

  if (!fs.existsSync(sourceRoot)) {
    return {
      ...base,
      sourceVolume: null,
      destinationVolume: null,
      copyBytes: 0,
      dependencyBytes: 0,
      sameDrive: false,
      canCopyDependencies: false,
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
  const where = destinationVolume?.name ?? "the new location";
  const isMainCheckout = isDirectory(path.join(sourceRoot, ".git"));
  const links = isMainCheckout ? listWorktreeLinks(sourceRoot, oldSpellings) : [];
  const lanes = lanesCheck(sourceRoot, links);
  const sameDrive = onSameVolume(sourceRoot, path.dirname(destinationRoot));
  const freeBytes = destinationVolume?.freeBytes ?? 0;
  // On the same drive the copy is made of clones, which take no space.
  const canCopyDependencies = sameDrive || freeBytes >= sizes.copyBytes + sizes.dependencyBytes + SPACE_MARGIN_BYTES;

  const checks: ProjectMoveCheck[] = [
    destinationCheck(sourceRoot, destinationRoot),
    driveCheck(sourceVolume, destinationVolume),
    spaceCheck(sizes, freeBytes, where, sameDrive),
    accessCheck(destinationRoot, where),
    quietCheck(args.activity),
    await holdersCheck(sourceRoot),
    gitCheck({ sourceRoot, projectName, isMainCheckout, git, links }),
    lanes.check,
  ];

  const agentHistory = summarizeAgentHistory(
    planAgentHistoryRenames({ oldSpellings, newRoot: destinationRoot, knownPaths: [sourceRoot, ...lanes.knownLanePaths] }),
    oldSpellings,
  );

  return {
    ...base,
    sourceVolume,
    destinationVolume,
    copyBytes: sizes.copyBytes,
    dependencyBytes: sizes.dependencyBytes,
    sameDrive,
    canCopyDependencies,
    laneCount: lanes.laneCount,
    checks,
    canMove: !checks.some((check) => check.status === "blocked"),
    notes: [
      ...(await afterMoveNotes(sourceRoot, links, oldSpellings, sameDrive ? 0 : sizes.dependencyBytes, sameDrive)),
      ...(await driveNotes(sourceRoot, destinationVolume)),
    ],
    agentHistory,
  };
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function destinationCheck(sourceRoot: string, destinationRoot: string): ProjectMoveCheck {
  const problems: string[] = [];
  if (process.platform !== "darwin") problems.push("Moving a project is only available on macOS for now.");
  if (isPathInside(destinationRoot, sourceRoot)) problems.push("The new location is inside the project itself.");
  else if (isPathInside(sourceRoot, destinationRoot)) problems.push("The project is inside the new location.");
  if (fs.existsSync(destinationRoot)) problems.push(`There is already a folder at ${destinationRoot}. Pick another place or name.`);
  if (fs.existsSync(copyLocation(destinationRoot)) && !ownsLeftoverCopy(destinationRoot)) {
    problems.push(`A folder from an earlier attempt is at ${copyLocation(destinationRoot)}. Delete it, then try again.`);
  }
  if (Buffer.byteLength(path.join(destinationRoot, ".ade", "ade.sock")) > MAX_SOCKET_PATH_BYTES) {
    problems.push("That path is too long for ADE's project connection. Pick a shorter folder.");
  }
  if (detectCloudStorageProvider(destinationRoot)) problems.push("That folder is synced by a cloud service, which can evict files ADE needs. Pick a local folder.");
  return problems.length
    ? { id: "destination", status: "blocked", title: "The new location can't be used", detail: problems.join(" ") }
    : { id: "destination", status: "ok", title: `New location: ${destinationRoot}` };
}

function spaceCheck(sizes: { copyBytes: number; dependencyBytes: number }, free: number, where: string, sameDrive: boolean): ProjectMoveCheck {
  if (sameDrive) {
    return free < SPACE_MARGIN_BYTES
      ? { id: "space", status: "blocked", title: `Not enough space on ${where}`, detail: `A move on the same drive takes almost no space, but ADE needs ${formatBytes(SPACE_MARGIN_BYTES)} free to work and ${where} has ${formatBytes(free)}.` }
      : { id: "space", status: "ok", title: "Same drive: the move takes almost no space", detail: "Files are cloned, not duplicated, and dependencies come along." };
  }
  const needed = sizes.copyBytes + SPACE_MARGIN_BYTES;
  if (free < needed) {
    return {
      id: "space",
      status: "blocked",
      title: `Not enough space on ${where}`,
      detail: `The project needs about ${formatBytes(needed)} and ${where} has ${formatBytes(free)} free.`,
    };
  }
  if (free < needed + sizes.dependencyBytes) {
    return {
      id: "space",
      status: "warning",
      title: "Enough space to move, but not to bring dependencies along",
      detail: `Moving needs ${formatBytes(sizes.copyBytes)}; dependencies need about ${formatBytes(sizes.dependencyBytes)} more, copied or reinstalled.`,
    };
  }
  return { id: "space", status: "ok", title: `Enough space on ${where}`, detail: `${formatBytes(sizes.copyBytes + sizes.dependencyBytes)} to copy with dependencies, ${formatBytes(free)} free.` };
}

/**
 * Processes other than ADE itself that have the project's database open: a
 * dev build started from a lane, a second ADE, a script. ADE closes its own
 * copy for the move; these don't, and the move stops when they still hold it.
 */
async function holdersCheck(sourceRoot: string): Promise<ProjectMoveCheck> {
  const dbPath = projectDatabasePath(sourceRoot);
  let pids: number[] = [];
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-t", "--", dbPath, `${dbPath}-wal`], { timeout: 10_000 });
    pids = [...new Set(stdout.split(/\s+/u).filter(Boolean).map(Number))];
  } catch (error) {
    // lsof exits 1 when nothing has the file open.
    const stdout = (error as { stdout?: string }).stdout ?? "";
    pids = [...new Set(stdout.split(/\s+/u).filter(Boolean).map(Number))];
  }
  const own = new Set([process.pid, process.ppid]);
  const others: string[] = [];
  for (const pid of pids) {
    if (!Number.isFinite(pid) || own.has(pid)) continue;
    let command = "";
    try {
      ({ stdout: command } = await execFileAsync("/bin/ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }));
    } catch {
      continue; // already gone
    }
    command = command.trim();
    // The installed app and its background service release the project when ADE closes it.
    if (command.startsWith("/Applications/ADE") || command.includes("/ADE.app/Contents/")) continue;
    others.push(`${pid}: ${command.length > 120 ? `${command.slice(0, 117)}…` : command}`);
  }
  if (!others.length) return { id: "holders", status: "ok", title: "Only ADE has the project's data open" };
  return {
    id: "holders",
    // A warning, not a block: one of these can be the background service of
    // the ADE running the move (a dev build), which lets go when asked. Any
    // that don't stop the move before it changes anything.
    status: "warning",
    title: `${others.length === 1 ? "Another program has" : `${others.length} other programs have`} the project's data open`,
    detail: "Usually a dev build of ADE started from a lane. Quit those first (stop their dev app or `ade serve`): if one still holds the data, the move stops before changing anything.",
    items: others,
  };
}

function quietCheck(activity: ProjectActivity): ProjectMoveCheck {
  if (activity.unknownReason) {
    return {
      id: "quiet",
      status: "blocked",
      title: "ADE couldn't check whether agents are working",
      detail: `${activity.unknownReason} Check again in a moment.`,
    };
  }
  if (activity.runningChats.length) {
    return {
      id: "quiet",
      status: "blocked",
      title: "Agents are working in this project",
      detail: "Wait for them to finish, or stop them, then check again.",
      items: activity.runningChats,
    };
  }
  if (activity.openTerminals.length) {
    return {
      id: "quiet",
      status: "warning",
      title: "Open terminals will close",
      detail: "The move closes the project, which ends these. Chats are kept.",
      items: activity.openTerminals,
    };
  }
  return { id: "quiet", status: "ok", title: "Nothing is running in the project" };
}

function gitCheck(args: {
  sourceRoot: string;
  projectName: string;
  isMainCheckout: boolean;
  git: [number, number] | null;
  links: WorktreeLink[];
}): ProjectMoveCheck {
  const problems: string[] = [];
  if (!args.isMainCheckout) problems.push("This project is itself a lane of another repository, so ADE can't move it on its own.");
  if (!args.git) problems.push("ADE couldn't run git.");
  else if (args.git[0] < MIN_GIT[0] || (args.git[0] === MIN_GIT[0] && args.git[1] < MIN_GIT[1])) {
    problems.push(`Git ${args.git.join(".")} is too old. Update to git ${MIN_GIT.join(".")} or later.`);
  }
  const gitDir = path.join(args.sourceRoot, ".git");
  const checkouts = args.isMainCheckout
    ? [
        { label: args.projectName, adminDir: gitDir },
        ...args.links.map((link) => ({
          label: link.relativePath ? path.basename(link.relativePath) : link.lanePath,
          adminDir: path.join(gitDir, "worktrees", link.name),
        })),
      ]
    : [];
  const busy = checkouts.filter((checkout) => gitBusyIn(checkout.adminDir)).map((checkout) => checkout.label);
  const operations = checkouts.flatMap((checkout) => {
    const operation = gitOperationIn(checkout.adminDir);
    return operation ? [`${checkout.label} (${operation})`] : [];
  });
  if (busy.length) problems.push(`Git is busy in ${busy.join(", ")}. Wait for it to finish.`);
  if (problems.length) return { id: "git", status: "blocked", title: "Git isn't ready", detail: problems.join(" ") };
  if (operations.length) return { id: "git", status: "warning", title: "Git is ready", detail: `In progress, and carried over as-is: ${operations.join(", ")}.` };
  return { id: "git", status: "ok", title: "Git is ready" };
}

function lanesCheck(sourceRoot: string, links: WorktreeLink[]): { check: ProjectMoveCheck; laneCount: number; knownLanePaths: string[] } {
  let summary: DatabaseSummary;
  try {
    summary = readProjectDatabaseSummary(projectDatabasePath(sourceRoot));
  } catch {
    return {
      check: { id: "lanes", status: "blocked", title: "ADE couldn't read this project's data", detail: "Open the project once so ADE can check it, then try again." },
      laneCount: 0,
      knownLanePaths: [],
    };
  }
  const laneCount = summary.lanes.filter((lane) => lane.status !== "archived" && lane.laneType !== "primary").length;
  const knownLanePaths = summary.lanes.map((lane) => lane.worktreePath).filter(Boolean);
  if (summary.projectCount !== 1) {
    return {
      check: { id: "lanes", status: "blocked", title: "ADE's data for this project needs a repair first", detail: `It lists ${summary.projectCount} projects instead of one.` },
      laneCount,
      knownLanePaths,
    };
  }
  const outside = links.filter((link) => link.relativePath === null && link.exists);
  const check: ProjectMoveCheck = outside.length
    ? {
        id: "lanes",
        status: "warning",
        title: `${outside.length === 1 ? "1 lane lives" : `${outside.length} lanes live`} outside the project`,
        detail: "Not copied. ADE links it to the moved project.",
        items: outside.map((link) => link.lanePath),
      }
    : { id: "lanes", status: "ok", title: `${laneCount} lane${laneCount === 1 ? "" : "s"} move with the project` };
  return { check, laneCount, knownLanePaths };
}

/** What ADE leaves for the person to do after the move. */
async function afterMoveNotes(sourceRoot: string, links: WorktreeLink[], oldSpellings: string[], dependencyBytes: number, sameDrive: boolean): Promise<ProjectMoveNote[]> {
  const notes: ProjectMoveNote[] = [];
  const lanes = links.flatMap((link) => (link.relativePath !== null && link.exists ? [path.join(sourceRoot, link.relativePath)] : []));
  const checkouts = [sourceRoot, ...lanes];
  const lockfile = lockfileKind(sourceRoot);
  // On the same drive dependencies are cloned with the project: nothing to do.
  if (!sameDrive && (dependencyBytes > 0 || lockfile)) {
    const command = installCommandFor(sourceRoot) ?? "your install command";
    const linked = dependencyLinksIntoProject(lanes, oldSpellings);
    notes.push({
      id: "dependencies",
      title: `Dependencies: copy them, or run ${command} after`,
      detail: [
        `${formatBytes(dependencyBytes)} of dependencies. Copy them with the project and nothing needs reinstalling; leave them out and ADE offers to run ${command} in each checkout after the move.`,
        lockfile === "pnpm" ? "pnpm keeps one store per drive: on another drive, the first pnpm install reinstalls once into a store there." : "",
        linked.length ? `${linked.length} lane link${linked.length === 1 ? "" : "s"} to the main checkout's dependencies only work once those are there:\n${linked.map((file) => path.relative(sourceRoot, file)).join("\n")}` : "",
      ].filter(Boolean).join("\n"),
    });
  }
  const mentions = await filesMentioningPath(checkouts, sourceRoot, oldSpellings);
  if (mentions.length) {
    notes.push({
      id: "mentions",
      title: `${mentions.length === MAX_MENTIONS ? `${MAX_MENTIONS}+` : mentions.length} file${mentions.length === 1 ? "" : "s"} name the old path`,
      detail: `ADE doesn't edit your files. The check agent after the move lists them with the change it would make.\n${mentions.join("\n")}`,
    });
  }
  if (hasPythonEnvironment(checkouts)) {
    notes.push({ id: "python", title: "Recreate Python virtual environments", detail: "A virtualenv records its own folder, so its scripts keep pointing at the old one." });
  }
  return notes;
}

function hasAppleProject(root: string): boolean {
  const visit = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace") || entry.name === "Package.swift") return true;
    }
    if (depth >= 3) return false;
    return entries.some((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && visit(path.join(dir, entry.name), depth + 1));
  };
  return visit(root, 0);
}

export async function timeMachineBacksUp(mountPath: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/tmutil", ["destinationinfo"], { timeout: 10_000 });
    if (/No destinations configured/iu.test(stdout)) return false;
  } catch (error) {
    if (/No destinations configured/iu.test(String((error as { stdout?: string; stderr?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? ""))) return false;
    return null;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/tmutil", ["isexcluded", mountPath], { timeout: 10_000 });
    return !/\[Excluded\]/u.test(stdout);
  } catch {
    return null;
  }
}

/** What a different drive changes for the project, beyond the copy itself. */
async function driveNotes(sourceRoot: string, destination: ProjectMoveVolume | null): Promise<ProjectMoveNote[]> {
  if (!destination || destination.internal) return [];
  const notes: ProjectMoveNote[] = [{
    id: "drive-connected",
    title: `Keep ${destination.name} connected while you work`,
    detail: `With ${destination.name} unplugged the project shows as offline, and its agents and scheduled wake-ups wait until it is back. ADE won't open a different drive that appears under the same name.`,
  }];
  if (hasAppleProject(sourceRoot)) {
    notes.push({
      id: "simulator",
      title: "Simulator screenshots go through ADE",
      detail: `macOS doesn't let the Simulator's own service write to ${destination.name}, so \`xcrun simctl io … screenshot\` or \`recordVideo\` into the project fails with "Operation not permitted". ADE's Apple tools capture on the internal disk and save the file for you; a hand-run simctl command should write to /tmp. Builds, installs and tests work from ${destination.name}.`,
    });
  }
  const backedUp = await timeMachineBacksUp(destination.mountPath);
  if (backedUp === false) {
    notes.push({
      id: "backup",
      title: `Time Machine doesn't back up ${destination.name}`,
      detail: "Your pushed branches are safe on GitHub, but unpushed work, ADE's chats and proof on that drive have no backup. Add the drive in System Settings → General → Time Machine if you want one.",
    });
  }
  return notes;
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
