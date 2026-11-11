import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ProjectCopyCheckoutState,
  ProjectCopySessions,
  ProjectCopyState,
} from "../../../shared/projectRemoval";
import { adeScaffoldFileContents } from "../../../shared/adeLayout";
import { runGit, type GitRunResult } from "../git/git";
import { isPathInside, pathKey } from "../shared/pathCompare";
import { listLaneWorktreeRoots } from "./projectDetailService";

/**
 * Reads what a delete of a project folder would lose, from git itself (never a
 * cache): every checkout of the project (the main folder, every lane under
 * `.ade/worktrees/`, and every other worktree of the repository, wherever it
 * is), each one's changed files and commits no remote has, and the
 * repository's stashes and unpushed branches.
 *
 * It runs when the remove dialog asks and again right before a delete, never
 * on a timer. Each checkout costs six short git reads, a bounded walk of
 * its ignored folders and a bounded stat of its changed files; at most {@link CHECKOUT_CONCURRENCY} checkouts are read
 * at once, under the git read cap every git read shares.
 */

const CHECKOUT_CONCURRENCY = 4;
const GIT_READ_TIMEOUT_MS = 15_000;
const MAX_ENV_FILES = 20;
/**
 * The ignored files people keep secrets in: `.env`, `.env.local`, `.envrc`,
 * keys and certificates, and credential or secret files.
 */
const ENV_FILE = /(^|\/)(\.env(rc|\..+)?|[^/]+\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
/** Entries one checkout's walk of its ignored folders reads, at most. */
const MAX_IGNORED_WALK_ENTRIES = 5_000;
/**
 * Changed and untracked paths whose size and time one checkout's fingerprint
 * reads, at most. Over it the fingerprint is unknown.
 */
const MAX_FINGERPRINT_PATHS = 5_000;
const FINGERPRINT_STAT_CONCURRENCY = 32;
/**
 * Ignored folders the walk does not open: dependencies, build output and
 * caches, which are large and hold no secrets of the person. `.ade` holds the
 * lanes, which are checkouts of their own.
 */
const SKIPPED_IGNORED_DIRS = new Set([
  "node_modules", ".git", ".ade", "dist", "build", "out", "target", "vendor", "coverage",
  ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", ".gradle", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", "Pods", "DerivedData", "bower_components",
]);

async function folderState(rootPath: string): Promise<"present" | "missing"> {
  try {
    const stat = await fs.stat(rootPath);
    return stat.isDirectory() ? "present" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // A folder that cannot be checked (no permission, a slow drive) is not gone.
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
}

async function realpathOr(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Every worktree git lists for the repository, by path (pruned ones left out). */
async function listGitWorktrees(rootPath: string): Promise<string[] | null> {
  const result = await runGit(["worktree", "list", "--porcelain"], { cwd: rootPath, timeoutMs: GIT_READ_TIMEOUT_MS });
  if (result.exitCode !== 0) return null;
  const paths: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}

function nonEmptyLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function countLines(raw: string): number {
  return nonEmptyLines(raw).length;
}

/** A `git status --porcelain=v1` line for an untracked path under `.ade/`. */
const UNTRACKED_ADE_LINE = /^\?\? "?\.ade\//;

/** Whether a file is exactly what ADE writes under `.ade/` (path and content). */
async function isAdeScaffoldFile(checkoutPath: string, relativeToCheckout: string): Promise<boolean> {
  const underAde = relativeToCheckout.replace(/^\.ade\//, "");
  const expected = adeScaffoldFileContents().get(underAde);
  if (expected === undefined) return false;
  try {
    const actual = await fs.readFile(path.join(checkoutPath, ...relativeToCheckout.split("/")), "utf8");
    return actual.replace(/\r\n/g, "\n") === expected;
  } catch {
    return false;
  }
}

/**
 * The changed files of a checkout, from `git status`, leaving out the files
 * ADE itself writes under `.ade/` when it opens a project. Status collapses an
 * untracked folder into one line (`?? .ade/`), so the untracked files under
 * `.ade/` are listed again one by one, and each counts unless it is exactly a
 * file of ADE's scaffold. Tracked changes always count. Null when git fails.
 */
async function countChangedFiles(checkoutPath: string, statusStdout: string): Promise<number | null> {
  const lines = nonEmptyLines(statusStdout);
  const others = lines.filter((line) => !UNTRACKED_ADE_LINE.test(line));
  if (others.length === lines.length) return lines.length;
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "--", ".ade"], {
    cwd: checkoutPath,
    timeoutMs: GIT_READ_TIMEOUT_MS,
  });
  if (untracked.exitCode !== 0) return null;
  const files = nonEmptyLines(untracked.stdout).map((line) => line.trim());
  const scaffold = await Promise.all(files.map((file) => isAdeScaffoldFile(checkoutPath, file)));
  return others.length + scaffold.filter((isScaffold) => !isScaffold).length;
}

function digest(facts: unknown): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

/** A fingerprint no other read matches: what it covers could not be read in full. */
function unknownFingerprint(): string {
  return `unknown:${randomUUID()}`;
}

function completeOutput(result: GitRunResult): string | null {
  return result.exitCode === 0 && !result.stdoutTruncated ? result.stdout : null;
}

/** The paths in `git status --porcelain=v2 -z` output, or null for a line it cannot read. */
function porcelainV2Paths(raw: string): string[] | null {
  const tokens = raw.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token) continue;
    const kind = token[0];
    const match = kind === "1" ? /^1 (?:\S+ ){7}(.+)$/s.exec(token)
      : kind === "2" ? /^2 (?:\S+ ){8}(.+)$/s.exec(token)
      : kind === "u" ? /^u (?:\S+ ){9}(.+)$/s.exec(token)
      : kind === "?" || kind === "!" ? /^. (.+)$/s.exec(token)
      : null;
    if (!match) return null;
    paths.push(match[1]!);
    // A rename or copy names its original path in the next field.
    if (kind === "2") index += 1;
  }
  return paths;
}

/** The size and modification time of a file, or "gone". Links are not followed. */
async function fileFingerprint(checkoutPath: string, relative: string): Promise<string> {
  try {
    const stat = await fs.lstat(path.join(checkoutPath, ...relative.split("/")), { bigint: true });
    return `${stat.size}:${stat.mtimeNs}`;
  } catch {
    return "gone";
  }
}

/**
 * A hash of a checkout's work, which its counts do not show: HEAD (an amended
 * commit), git's status (the staged content of each file), and the size and
 * time of each changed, untracked and ignored secret file (a second edit of a
 * file that was already changed). Content is not read: the inspect and the
 * recheck run in one process with the same calls, so paths and time
 * precision (Windows included) are the same both times.
 */
async function checkoutFingerprint(args: {
  checkoutPath: string;
  head: GitRunResult;
  noCommits: boolean;
  status: GitRunResult;
  ignoredEnvFiles: string[];
}): Promise<string> {
  const headOutput = completeOutput(args.head);
  const statusOutput = completeOutput(args.status);
  if ((headOutput === null && !args.noCommits) || statusOutput === null) return unknownFingerprint();
  const paths = porcelainV2Paths(statusOutput);
  if (!paths || paths.length > MAX_FINGERPRINT_PATHS) return unknownFingerprint();
  const files = [...paths, ...args.ignoredEnvFiles];
  const stats = await mapLimited(files, FINGERPRINT_STAT_CONCURRENCY, (file) => fileFingerprint(args.checkoutPath, file));
  return digest([headOutput?.trim() ?? null, statusOutput, files.map((file, index) => [file, stats[index]])]);
}

function parseCount(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readCheckout(args: {
  checkoutPath: string;
  projectRoot: string;
  isMain: boolean;
}): Promise<ProjectCopyCheckoutState> {
  const cwd = args.checkoutPath;
  const opts = { cwd, timeoutMs: GIT_READ_TIMEOUT_MS };
  const insideProject = args.isMain || isPathInside(cwd, args.projectRoot);
  const [branchRes, statusRes, unpushedRes, ignoredRes, hasSubmodules, headRes, workStatusRes] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], opts),
    runGit(["status", "--porcelain=v1", "--untracked-files=normal"], opts),
    // Commits on HEAD that no remote-tracking branch has. With no upstream, or
    // a detached HEAD, it still counts them; with no remote at all, every
    // commit is only here.
    runGit(["rev-list", "--count", "HEAD", "--not", "--remotes"], opts),
    // Only for folders a delete removes. `--directory` lists an ignored folder
    // (node_modules) as one line instead of every file in it.
    insideProject
      ? runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], opts)
      : Promise.resolve(null),
    exists(path.join(cwd, ".gitmodules")),
    // For the fingerprint: every untracked file, not one line per folder.
    runGit(["rev-parse", "HEAD"], opts),
    runGit(["status", "--porcelain=v2", "-z", "--untracked-files=all"], opts),
  ]);
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : "";
  const ignoredEnvFiles = ignoredRes && ignoredRes.exitCode === 0
    ? await findIgnoredEnvFiles(cwd, ignoredRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    : [];
  // A repository with no commit yet has no HEAD: nothing to lose but its files.
  const noCommits = unpushedRes.exitCode !== 0 && /unknown revision|bad revision|ambiguous argument 'HEAD'/i.test(unpushedRes.stderr);
  return {
    path: cwd,
    isMain: args.isMain,
    insideProject,
    branch: branch && branch !== "HEAD" ? branch : null,
    changedFiles: statusRes.exitCode === 0 ? await countChangedFiles(cwd, statusRes.stdout) : null,
    unpushedCommits: unpushedRes.exitCode === 0 ? parseCount(unpushedRes.stdout) : noCommits ? 0 : null,
    ignoredEnvFiles,
    hasSubmodules,
    fingerprint: await checkoutFingerprint({ checkoutPath: cwd, head: headRes, noCommits, status: workStatusRes, ignoredEnvFiles }),
  };
}

/**
 * The secret-like files among the ignored paths of a checkout. `--directory`
 * lists an ignored folder as one line, so each ignored folder is walked for
 * the files in it (a `.env` in `config/`), except the dependency and build
 * folders. Links are not followed. The walk stops after
 * {@link MAX_IGNORED_WALK_ENTRIES} entries or {@link MAX_ENV_FILES} files.
 */
async function findIgnoredEnvFiles(checkoutPath: string, ignoredLines: string[]): Promise<string[]> {
  const found: string[] = [];
  const folders: string[] = [];
  for (const line of ignoredLines) {
    if (line.endsWith("/")) folders.push(line.slice(0, -1));
    else if (ENV_FILE.test(line)) found.push(line);
  }
  let budget = MAX_IGNORED_WALK_ENTRIES;
  const queue = folders.filter((folder) => !SKIPPED_IGNORED_DIRS.has(path.posix.basename(folder)));
  while (queue.length > 0 && budget > 0 && found.length < MAX_ENV_FILES) {
    const folder = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(checkoutPath, ...folder.split("/")), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (--budget < 0) break;
      const relative = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_IGNORED_DIRS.has(entry.name)) queue.push(relative);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && ENV_FILE.test(relative)) {
        found.push(relative);
      }
    }
  }
  return found.slice(0, MAX_ENV_FILES);
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The state of the copy at `rootPath`. `sessions` comes from the caller,
 * which knows the project's runtime; a folder that is gone reports no
 * checkouts and no work.
 */
export async function readProjectCopyState(rootPath: string, sessions: ProjectCopySessions): Promise<ProjectCopyState> {
  const folder = await folderState(rootPath);
  const base: ProjectCopyState = {
    rootPath,
    folder,
    isGitRepo: false,
    checkouts: [],
    stashes: null,
    unpushedOnBranches: null,
    sessions,
    unreadable: [],
    fingerprint: "",
  };
  if (folder === "missing") return { ...base, stashes: 0, unpushedOnBranches: 0 };
  if (!(await exists(path.join(rootPath, ".git")))) return base;

  const unreadable: string[] = [];
  // Compared by real path: git lists worktrees with links resolved
  // (`/private/tmp/…` on macOS), and the registered folder may be a link.
  const realRoot = await realpathOr(rootPath);
  const mainKey = pathKey(realRoot);
  const byKey = new Map<string, string>([[mainKey, realRoot]]);
  const listed = await listGitWorktrees(rootPath);
  if (listed === null) unreadable.push("worktrees");
  for (const worktree of listed ?? []) {
    if (!(await exists(worktree))) continue;
    const real = await realpathOr(worktree);
    if (!byKey.has(pathKey(real))) byKey.set(pathKey(real), real);
  }
  // Lane folders git no longer lists still sit in the project folder.
  for (const lane of await listLaneWorktreeRoots(realRoot)) {
    const real = await realpathOr(lane.rootPath);
    if (!byKey.has(pathKey(real)) && await exists(path.join(real, ".git"))) byKey.set(pathKey(real), real);
  }
  const checkoutPaths = [...byKey.entries()];
  const [checkouts, stashRes, branchesRes, tipsRes] = await Promise.all([
    mapLimited(checkoutPaths, CHECKOUT_CONCURRENCY, ([key, checkoutPath]) =>
      readCheckout({ checkoutPath, projectRoot: realRoot, isMain: key === mainKey })),
    runGit(["stash", "list", "--format=%H"], { cwd: rootPath, timeoutMs: GIT_READ_TIMEOUT_MS }),
    runGit(["rev-list", "--count", "--branches", "--not", "--remotes"], { cwd: rootPath, timeoutMs: GIT_READ_TIMEOUT_MS }),
    // Every local branch tip: a commit amended on a branch no checkout has out.
    runGit(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], { cwd: rootPath, timeoutMs: GIT_READ_TIMEOUT_MS }),
  ]);
  const stashOutput = completeOutput(stashRes);
  const tipsOutput = completeOutput(tipsRes);
  // `rev-list` fails on a repository with no commit yet. Zero only when the
  // full branch list confirms there is no branch at all: a scan that failed
  // or timed out on a large branch stays unknown, so the removal asks.
  const noBranches = branchesRes.exitCode !== 0 && tipsOutput !== null && countLines(tipsOutput) === 0;
  return {
    ...base,
    isGitRepo: true,
    checkouts,
    stashes: stashRes.exitCode === 0 ? countLines(stashRes.stdout) : null,
    unpushedOnBranches: branchesRes.exitCode === 0 ? parseCount(branchesRes.stdout) : noBranches ? 0 : null,
    unreadable,
    fingerprint: stashOutput !== null && tipsOutput !== null ? digest([stashOutput, tipsOutput]) : unknownFingerprint(),
  };
}

/** Lane folders that a delete of the project folder leaves on disk. */
export function outsideLaneFolders(state: ProjectCopyState): string[] {
  return state.checkouts.filter((checkout) => !checkout.insideProject).map((checkout) => checkout.path);
}
