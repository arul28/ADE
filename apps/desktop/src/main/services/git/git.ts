import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ConflictFileType } from "../../../shared/types";
import { terminateProcessTree } from "../shared/processExecution";
import { pathKey } from "../shared/pathCompare";
import {
  resolveExecutableCandidatesFromKnownLocations,
  type ResolvedExecutable,
} from "../ai/cliExecutableResolver";
import {
  cachedGitRepoValue,
  invalidateGitRepoCache,
  isRefAffectingGitCommand,
  type GitRepoCacheClass,
} from "./gitRepoCache";

// Electron apps launched from Finder/Dock can have a stripped PATH that misses
// where the user actually installed git (e.g. /opt/homebrew/bin on Apple
// Silicon when shell PATH probe times out). Resolve git's absolute path once
// and reuse it so spawn never throws ENOENT.
let cachedGitExecutable: string | null = null;
let gitExecutableResolution: Promise<string> | null = null;
const execFileAsync = promisify(execFile);
export function selectGitExecutable(
  candidates: readonly ResolvedExecutable[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const selected = platform === "darwin"
    ? candidates.find((candidate) => candidate.path !== "/usr/bin/git") ?? candidates[0]
    : candidates[0];
  return selected?.path ?? null;
}

export function shouldProbeLoginShellForGit(
  selectedExecutable: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return selectedExecutable == null
    || (platform === "darwin" && selectedExecutable === "/usr/bin/git");
}

async function resolveGitExecutable(): Promise<string> {
  if (cachedGitExecutable) return cachedGitExecutable;
  if (gitExecutableResolution) return await gitExecutableResolution;
  gitExecutableResolution = resolveGitExecutableUncached();
  try {
    return await gitExecutableResolution;
  } finally {
    gitExecutableResolution = null;
  }
}

async function resolveGitExecutableUncached(): Promise<string> {
  if (process.env.ADE_GIT_EXECUTABLE && fs.existsSync(process.env.ADE_GIT_EXECUTABLE)) {
    cachedGitExecutable = process.env.ADE_GIT_EXECUTABLE;
    return cachedGitExecutable;
  }
  const candidates = resolveExecutableCandidatesFromKnownLocations(
    process.platform === "win32" ? "git.exe" : "git",
  );
  const resolvedCandidate = selectGitExecutable(candidates);
  // A packaged macOS app can inherit a PATH containing only /usr/bin even
  // though the user's login shell exposes an independent Git via a custom
  // package-manager or version-manager directory. Check that shell before
  // accepting Apple's license-gated Git.
  if (process.platform !== "win32" && shouldProbeLoginShellForGit(resolvedCandidate)) {
    try {
      const shell = process.env.SHELL?.trim() || "/bin/sh";
      const { stdout } = await execFileAsync(shell, ["-lc", "command -v git"], {
        encoding: "utf8",
        timeout: 3_000,
      });
      const out = stdout.trim();
      const isIndependentMacGit = process.platform !== "darwin" || out !== "/usr/bin/git";
      if (out && fs.existsSync(out) && (isIndependentMacGit || !resolvedCandidate)) {
        cachedGitExecutable = out;
        return cachedGitExecutable;
      }
    } catch {
      // fall through
    }
  }
  if (resolvedCandidate) {
    cachedGitExecutable = resolvedCandidate;
    return cachedGitExecutable;
  }
  // Fall back to bare "git" — spawn will surface the original ENOENT with a
  // clearer pre-check error message wrapped around it.
  cachedGitExecutable = process.platform === "win32" ? "git.exe" : "git";
  return cachedGitExecutable;
}

function gitExecutableNotFoundMessage(executable: string): string {
  if (process.platform === "darwin") {
    return `git executable not found (tried ${executable}). Install Xcode Command Line Tools or set ADE_GIT_EXECUTABLE to git's absolute path.`;
  }
  if (process.platform === "win32") {
    return `git executable not found (tried ${executable}). Install Git for Windows or set ADE_GIT_EXECUTABLE to git's absolute path.`;
  }
  if (process.platform === "linux") {
    return `git executable not found (tried ${executable}). Install git with your package manager or set ADE_GIT_EXECUTABLE to git's absolute path.`;
  }
  return `git executable not found (tried ${executable}). Install git or set ADE_GIT_EXECUTABLE to git's absolute path.`;
}

function gitSpawnErrorMessage(error: NodeJS.ErrnoException, opts: GitRunOptions, executable: string): string {
  if (error.code !== "ENOENT") return error.message;
  if (!fs.existsSync(opts.cwd)) {
    return `git working directory not found: ${opts.cwd}`;
  }
  return gitExecutableNotFoundMessage(executable);
}

export type GitRunOptions = {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
};

export type GitRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type GitMergeTreeConflict = {
  path: string;
  conflictType: ConflictFileType;
  markerPreview: string;
};

export type GitMergeTreeResult = GitRunResult & {
  mergeBase: string;
  branchA: string;
  branchB: string;
  conflicts: GitMergeTreeConflict[];
  treeOid: string | null;
  usedMergeBaseFlag: boolean;
  usedWriteTree: boolean;
};

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STALE_GIT_INDEX_LOCK_MIN_AGE_MS = 2 * 60_000;
let mergeTreeMergeBaseSupportPromise: Promise<boolean> | null = null;
const activeGitPids = new Set<number>();

function extractIndexLockPath(message: string): string | null {
  const singleQuoteMatch = message.match(/Unable to create '([^']*index\.lock)'/);
  if (singleQuoteMatch?.[1]) return singleQuoteMatch[1];
  const doubleQuoteMatch = message.match(/Unable to create "([^"]*index\.lock)"/);
  return doubleQuoteMatch?.[1] ?? null;
}

async function isIndexLockHeldByProcess(lockPath: string): Promise<boolean> {
  if (activeGitPids.size > 0) return true;
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execFileAsync("lsof", [lockPath], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return stdout.trim().split(/\r?\n/).length > 1;
  } catch {
    return false;
  }
}

async function recoverStaleIndexLock(lockPath: string): Promise<boolean> {
  try {
    const normalizedPath = path.normalize(lockPath);
    if (path.basename(normalizedPath) !== "index.lock") return false;
    if (!normalizedPath.includes(`${path.sep}.git${path.sep}`)) return false;
    if (!fs.existsSync(lockPath)) return false;
    const stat = fs.statSync(lockPath);
    if (!stat.isFile()) return false;
    if (Date.now() - stat.mtimeMs < STALE_GIT_INDEX_LOCK_MIN_AGE_MS) return false;
    if (await isIndexLockHeldByProcess(lockPath)) return false;
    fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function shouldRetryAfterIndexLock(result: GitRunResult): Promise<boolean> {
  if (result.exitCode === 0) return false;
  const message = `${result.stderr}\n${result.stdout}`;
  const lockPath = extractIndexLockPath(message);
  if (!lockPath) return false;
  if (!message.includes("Another git process seems to be running")) return false;
  return await recoverStaleIndexLock(lockPath);
}

function appendChunkWithCap(args: {
  current: string;
  chunk: Buffer;
  currentBytes: number;
  maxBytes: number;
}): { text: string; bytes: number; truncated: boolean } {
  const { current, chunk, currentBytes, maxBytes } = args;
  if (maxBytes <= 0 || currentBytes >= maxBytes) {
    return { text: current, bytes: currentBytes, truncated: true };
  }
  const remaining = maxBytes - currentBytes;
  if (chunk.length <= remaining) {
    return {
      text: current + chunk.toString("utf8"),
      bytes: currentBytes + chunk.length,
      truncated: false
    };
  }
  return {
    text: current + chunk.subarray(0, remaining).toString("utf8"),
    bytes: maxBytes,
    truncated: true
  };
}

async function runGitOnce(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = Number.isFinite(opts.maxOutputBytes)
    ? Math.max(0, Math.floor(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES))
    : DEFAULT_MAX_OUTPUT_BYTES;

  const executable = await resolveGitExecutable();
  return await new Promise<GitRunResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (typeof child.pid === "number" && child.pid > 0) {
      activeGitPids.add(child.pid);
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(onTimeout);
      if (typeof child.pid === "number" && child.pid > 0) {
        activeGitPids.delete(child.pid);
      }
      resolve(result);
    };

    const onTimeout = setTimeout(() => {
      terminateProcessTree(child, "SIGKILL");
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr.length ? stderr : "git timed out",
        timedOut: true,
        stdoutTruncated,
        stderrTruncated
      });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer | string) => {
      if (stdoutTruncated) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d), "utf8");
      const next = appendChunkWithCap({
        current: stdout,
        chunk,
        currentBytes: stdoutBytes,
        maxBytes: maxOutputBytes
      });
      stdout = next.text;
      stdoutBytes = next.bytes;
      stdoutTruncated = next.truncated;
    });
    child.stderr.on("data", (d: Buffer | string) => {
      if (stderrTruncated) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d), "utf8");
      const next = appendChunkWithCap({
        current: stderr,
        chunk,
        currentBytes: stderrBytes,
        maxBytes: maxOutputBytes
      });
      stderr = next.text;
      stderrBytes = next.bytes;
      stderrTruncated = next.truncated;
    });

    child.on("error", (error) => {
      const friendlyMessage = gitSpawnErrorMessage(error as NodeJS.ErrnoException, opts, executable);
      finish({
        exitCode: 1,
        stdout,
        stderr: stderr.length ? stderr : friendlyMessage,
        stdoutTruncated,
        stderrTruncated
      });
    });

    child.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}

/**
 * Global ceiling on concurrent `git` processes.
 *
 * Nothing bounded this before. A lane status refresh fans out with an uncapped
 * `Promise.all` per service, and on a 14-lane checkout that peaked at 32
 * simultaneous git processes — linear in lane count, so 40 lanes would reach
 * ~90. Measured spawn costs on that repo are 10-27 ms each, so serializing
 * behind a modest cap costs no meaningful wall time while removing the
 * thundering-herd tail. It matters much more on Windows, where process creation
 * runs 35-100 ms.
 *
 * One shared cap rather than a limit per call site: the fan-outs do not know
 * about each other, which is exactly how 32 happened.
 */
const MAX_CONCURRENT_GIT_PROCESSES = 12;
let runningGitProcesses = 0;
const gitProcessQueue: Array<() => void> = [];

async function acquireGitSlot(): Promise<void> {
  if (runningGitProcesses < MAX_CONCURRENT_GIT_PROCESSES) {
    runningGitProcesses += 1;
    return;
  }
  // The waiter is resolved by releaseGitSlot, which hands its slot over rather
  // than freeing it — so the count stays accurate and never dips below the
  // truth in the window between wake-up and resume. Decrementing first let a
  // caller arriving in that window see an undercount and overshoot the cap.
  await new Promise<void>((resolve) => { gitProcessQueue.push(resolve); });
}

function releaseGitSlot(): void {
  const next = gitProcessQueue.shift();
  if (next) next();
  else runningGitProcesses -= 1;
}

export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  // Mutations skip the queue. The cap exists to bound read fan-out — one
  // refresh issues ~130 reads across services that do not know about each
  // other — and mutations are neither numerous nor interchangeable with it:
  // they are user-initiated, and several run with multi-minute timeouts
  // (`rebase --continue` allows 300s). Queueing a Commit or Push behind a bulk
  // conflict assessment would be a priority inversion the old unbounded code
  // did not have, and it is one gate for every project in a shared brain.
  const mutating = isRefAffectingGitCommand(args);
  if (!mutating) await acquireGitSlot();
  let result: GitRunResult;
  try {
    result = await runGitOnce(args, opts);
    if (await shouldRetryAfterIndexLock(result)) {
      result = await runGitOnce(args, opts);
    }
  } finally {
    if (!mutating) releaseGitSlot();
  }
  // Invalidate on failure as well as success. A rejected push can still have
  // updated a remote-tracking ref, and an aborted rebase leaves HEAD moved — a
  // cache that only drops on success would keep serving the pre-command answer
  // for exactly the commands most likely to have changed it.
  //
  // Invalidating here rather than at each mutation call site is what makes the
  // cache safe to add: nothing has to remember, including code written later
  // and code that shells out through a path nobody mapped.
  if (mutating) {
    // `undefined` when this cwd's repo has not been resolved yet, which drops
    // every repository. Over-invalidating costs a re-read; guessing wrong the
    // other way serves a stale answer.
    invalidateGitRepoCache(knownGitCommonDir(opts.cwd));
  }
  return result;
}

const gitCommonDirByCwd = new Map<string, string>();
const gitCommonDirRetryAtByCwd = new Map<string, number>();
const gitCommonDirInFlight = new Map<string, Promise<string>>();

/**
 * How long a failed common-dir probe is remembered.
 *
 * Neither extreme works. Memoizing a failure forever means one transient
 * timeout silently disables this repo's cache for the process lifetime.
 * Remembering nothing means a repo that genuinely cannot answer re-probes on
 * every single cached read *and* misses the cache — strictly worse than not
 * caching at all. A short window gives up on the repo briefly, then retries.
 */
const GIT_COMMON_DIR_RETRY_MS = 60_000;

/** The memoized common git dir for `cwd`, or undefined if not resolved yet. */
export function knownGitCommonDir(cwd: string): string | undefined {
  return gitCommonDirByCwd.get(pathKey(cwd));
}

/**
 * Absolute common git dir for `cwd` — the directory every lane worktree of one
 * repository shares, and therefore the key everything repo-scoped hangs off.
 *
 * Memoized for the process lifetime on success: a worktree's common dir is
 * fixed when the worktree is created. Returns `""` when the path is not a git
 * repository, which callers treat as "do not cache".
 *
 * Deliberately not `--path-format=absolute`, which needs git 2.31 (2021). Bare
 * `--git-common-dir` answers on every version and may return a path relative to
 * `cwd`, so resolve it here.
 */
export async function gitCommonDirFor(cwd: string): Promise<string> {
  const cacheKey = pathKey(cwd);
  const memo = gitCommonDirByCwd.get(cacheKey);
  if (memo !== undefined) return memo;
  const retryAt = gitCommonDirRetryAtByCwd.get(cacheKey);
  if (retryAt !== undefined && retryAt > Date.now()) return "";
  const existing = gitCommonDirInFlight.get(cacheKey);
  if (existing) return await existing;

  const request = (async () => {
    const res = await runGit(["rev-parse", "--git-common-dir"], {
      cwd,
      timeoutMs: 8_000,
      maxOutputBytes: 8 * 1024,
    });
    const raw = res.exitCode === 0 ? res.stdout.trim() : "";
    if (!raw) {
      gitCommonDirRetryAtByCwd.set(cacheKey, Date.now() + GIT_COMMON_DIR_RETRY_MS);
      return "";
    }
    const resolved = path.resolve(cwd, raw);
    gitCommonDirByCwd.set(cacheKey, resolved);
    gitCommonDirRetryAtByCwd.delete(cacheKey);
    return resolved;
  })().finally(() => {
    if (gitCommonDirInFlight.get(cacheKey) === request) gitCommonDirInFlight.delete(cacheKey);
  });
  gitCommonDirInFlight.set(cacheKey, request);
  return await request;
}

/**
 * Run a read-only git command whose answer is the same for every worktree of
 * the repository, serving it from the repo-scoped cache when it is warm.
 *
 * `key` must describe the question, not the caller — two services asking for
 * the same ref's SHA should collide on purpose.
 */
export async function runGitRepoCached(
  args: string[],
  opts: GitRunOptions,
  cache: { key: string; cacheClass: GitRepoCacheClass },
): Promise<GitRunResult> {
  const commonGitDir = await gitCommonDirFor(opts.cwd);
  return await cachedGitRepoValue<GitRunResult>({
    commonGitDir,
    key: cache.key,
    cacheClass: cache.cacheClass,
    load: () => runGit(args, opts),
  });
}

export function resetGitCommonDirCacheForTests(): void {
  gitCommonDirByCwd.clear();
  gitCommonDirRetryAtByCwd.clear();
  gitCommonDirInFlight.clear();
}

export async function runGitOrThrow(args: string[], opts: GitRunOptions): Promise<string> {
  const res = await runGit(args, opts);
  if (res.exitCode !== 0) {
    const raw = res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(formatGitExecutionError(raw));
  }
  return res.stdout;
}

export function formatGitExecutionError(raw: string): string {
  if (!/not agreed to the Xcode license agreements/i.test(raw)) return raw;
  return "ADE needs Git to open and manage this project. macOS blocked Apple's Git because the Xcode license has not been accepted. This is a Git requirement, not an ADE iOS Simulator or code-signing requirement. In Terminal, run `sudo xcodebuild -license`, or install Git separately (for example with Homebrew) and restart ADE.";
}

/**
 * Read the HEAD SHA (or null if unavailable) for a given worktree path.
 * Shared across gitOperationsService, laneService, autoRebaseService, and rebaseSuggestionService.
 */
export async function getHeadSha(worktreePath: string): Promise<string | null> {
  // Shares the repo cache — and the key shape — with conflictService's own HEAD
  // read, which is how the two spawns every lane used to pay become one.
  const res = await runGitRepoCached(
    ["rev-parse", "HEAD"],
    { cwd: worktreePath, timeoutMs: 8_000 },
    { key: `rev-parse:${worktreePath}:HEAD`, cacheClass: "volatile" },
  );
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length ? sha : null;
}

export function normalizeConflictType(raw: string): ConflictFileType {
  const value = raw.trim().toLowerCase();
  if (value.includes("rename")) return "rename";
  if (value.includes("delete")) return "delete";
  if (value.includes("add")) return "add";
  return "content";
}

function parseMergeTreeConflicts(output: string): GitMergeTreeConflict[] {
  const lines = output.split(/\r?\n/);
  const byPath = new Map<string, GitMergeTreeConflict>();

  const addConflict = (path: string, type: ConflictFileType, markerPreview: string) => {
    const clean = path.trim();
    if (!clean.length) return;
    if (byPath.has(clean)) return;
    byPath.set(clean, { path: clean, conflictType: type, markerPreview });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const conflictMatch = line.match(/^CONFLICT \(([^)]+)\): .* in (.+)$/);
    if (conflictMatch) {
      const type = normalizeConflictType(conflictMatch[1] ?? "");
      const path = (conflictMatch[2] ?? "").trim();
      const markerPreview = [lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join("\n");
      addConflict(path, type, markerPreview);
      continue;
    }

    const autoMergingMatch = line.match(/^Auto-merging (.+)$/);
    if (autoMergingMatch && (lines[i + 1] ?? "").startsWith("CONFLICT")) {
      const next = lines[i + 1] ?? "";
      const typeMatch = next.match(/^CONFLICT \(([^)]+)\):/);
      const type = normalizeConflictType(typeMatch?.[1] ?? "");
      const path = (autoMergingMatch[1] ?? "").trim();
      const markerPreview = [line, next, lines[i + 2]].filter(Boolean).join("\n");
      addConflict(path, type, markerPreview);
    }
  }

  return Array.from(byPath.values());
}

function parseMergeTreeTreeOid(output: string): string | null {
  const first = output
    .replace(/\0/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return null;
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(first) ? first : null;
}

function looksLikeMergeTreeUsage(output: string): boolean {
  const normalized = output.trim().toLowerCase();
  if (!normalized.length) return false;
  return normalized.includes("usage: git merge-tree")
    || normalized.includes("unknown option")
    || normalized.includes("unknown switch");
}

async function supportsMergeTreeMergeBaseFlag(cwd: string): Promise<boolean> {
  if (!mergeTreeMergeBaseSupportPromise) {
    mergeTreeMergeBaseSupportPromise = (async () => {
      const help = await runGit(["merge-tree", "-h"], { cwd, timeoutMs: 10_000 });
      const combined = `${help.stdout}\n${help.stderr}`.toLowerCase();
      return combined.includes("--merge-base");
    })().catch(() => true);
  }
  return await mergeTreeMergeBaseSupportPromise;
}

export async function runGitMergeTree(args: {
  cwd: string;
  mergeBase: string;
  branchA: string;
  branchB: string;
  timeoutMs?: number;
}): Promise<GitMergeTreeResult> {
  const timeoutMs = args.timeoutMs ?? 45_000;
  const supportsMergeBaseFlag = await supportsMergeTreeMergeBaseFlag(args.cwd);
  const writeTreeCmd = supportsMergeBaseFlag
    ? [
        "merge-tree",
        "--write-tree",
        "--messages",
        "--merge-base",
        args.mergeBase,
        args.branchA,
        args.branchB
      ]
    : [
        "merge-tree",
        "--write-tree",
        "--messages",
        args.branchA,
        args.branchB
      ];

  let writeTree = await runGit(writeTreeCmd, { cwd: args.cwd, timeoutMs });
  let usedMergeBaseFlag = supportsMergeBaseFlag;
  let combined = `${writeTree.stdout}\n${writeTree.stderr}`;

  if (
    supportsMergeBaseFlag
    && writeTree.exitCode !== 0
    && looksLikeMergeTreeUsage(combined)
  ) {
    writeTree = await runGit(
      ["merge-tree", "--write-tree", "--messages", args.branchA, args.branchB],
      { cwd: args.cwd, timeoutMs }
    );
    usedMergeBaseFlag = false;
    combined = `${writeTree.stdout}\n${writeTree.stderr}`;
  }

  return {
    ...writeTree,
    mergeBase: args.mergeBase,
    branchA: args.branchA,
    branchB: args.branchB,
    conflicts: looksLikeMergeTreeUsage(combined) ? [] : parseMergeTreeConflicts(combined),
    treeOid: parseMergeTreeTreeOid(writeTree.stdout),
    usedMergeBaseFlag,
    usedWriteTree: true
  };
}
