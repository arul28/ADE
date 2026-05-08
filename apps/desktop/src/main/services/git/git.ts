import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ConflictFileType } from "../../../shared/types";
import { terminateProcessTree } from "../shared/processExecution";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";

// Electron apps launched from Finder/Dock can have a stripped PATH that misses
// where the user actually installed git (e.g. /opt/homebrew/bin on Apple
// Silicon when shell PATH probe times out). Resolve git's absolute path once
// and reuse it so spawn never throws ENOENT.
let cachedGitExecutable: string | null = null;
function resolveGitExecutable(): string {
  if (cachedGitExecutable) return cachedGitExecutable;
  if (process.env.ADE_GIT_EXECUTABLE && fs.existsSync(process.env.ADE_GIT_EXECUTABLE)) {
    cachedGitExecutable = process.env.ADE_GIT_EXECUTABLE;
    return cachedGitExecutable;
  }
  const fromKnown = resolveExecutableFromKnownLocations(process.platform === "win32" ? "git.exe" : "git");
  if (fromKnown?.path) {
    cachedGitExecutable = fromKnown.path;
    return cachedGitExecutable;
  }
  // Last resort: ask the user's login shell. Slower, but only runs if the
  // direct probe missed (e.g. git lives in an unusual nvm/asdf shim dir).
  if (process.platform !== "win32") {
    try {
      const shell = process.env.SHELL?.trim() || "/bin/sh";
      const out = execFileSync(shell, ["-lc", "command -v git"], {
        encoding: "utf8",
        timeout: 3_000,
      }).trim();
      if (out && fs.existsSync(out)) {
        cachedGitExecutable = out;
        return cachedGitExecutable;
      }
    } catch {
      // fall through
    }
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
const STALE_GIT_INDEX_LOCK_MIN_AGE_MS = 15_000;
let mergeTreeMergeBaseSupportPromise: Promise<boolean> | null = null;
const activeGitPids = new Set<number>();

function extractIndexLockPath(message: string): string | null {
  const singleQuoteMatch = message.match(/Unable to create '([^']*index\.lock)'/);
  if (singleQuoteMatch?.[1]) return singleQuoteMatch[1];
  const doubleQuoteMatch = message.match(/Unable to create "([^"]*index\.lock)"/);
  return doubleQuoteMatch?.[1] ?? null;
}

function recoverStaleIndexLock(lockPath: string): boolean {
  try {
    const normalizedPath = path.normalize(lockPath);
    if (path.basename(normalizedPath) !== "index.lock") return false;
    if (!normalizedPath.includes(`${path.sep}.git${path.sep}`)) return false;
    if (activeGitPids.size > 0) return false;
    if (!fs.existsSync(lockPath)) return false;
    const stat = fs.statSync(lockPath);
    if (!stat.isFile()) return false;
    if (Date.now() - stat.mtimeMs < STALE_GIT_INDEX_LOCK_MIN_AGE_MS) return false;
    fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

function shouldRetryAfterIndexLock(result: GitRunResult): boolean {
  if (result.exitCode === 0) return false;
  const message = `${result.stderr}\n${result.stdout}`;
  const lockPath = extractIndexLockPath(message);
  if (!lockPath) return false;
  if (!message.includes("Another git process seems to be running")) return false;
  return recoverStaleIndexLock(lockPath);
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

  return await new Promise<GitRunResult>((resolve) => {
    const gitExecutable = resolveGitExecutable();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(gitExecutable, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"]
      }) as ChildProcessByStdio<null, Readable, Readable>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const message = `Unable to start git${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}`;
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: message,
      });
      return;
    }
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
      const code = (error as NodeJS.ErrnoException)?.code;
      const friendlyMessage =
        code === "ENOENT"
          ? gitExecutableNotFoundMessage(gitExecutable)
          : `Unable to start git${code ? ` (${code})` : ""}: ${error.message}`;
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

export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const first = await runGitOnce(args, opts);
  if (!shouldRetryAfterIndexLock(first)) {
    return first;
  }
  return await runGitOnce(args, opts);
}

export async function runGitOrThrow(args: string[], opts: GitRunOptions): Promise<string> {
  const res = await runGit(args, opts);
  if (res.exitCode !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(msg);
  }
  return res.stdout;
}

/**
 * Read the HEAD SHA (or null if unavailable) for a given worktree path.
 * Shared across gitOperationsService, laneService, autoRebaseService, and rebaseSuggestionService.
 */
export async function getHeadSha(worktreePath: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
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
