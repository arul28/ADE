/**
 * Shared backend utility functions.
 *
 * These were previously duplicated across 10+ service files.
 * Import from here instead of re-declaring locally.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveCliSpawnInvocation, windowsTaskkillCommand } from "./processExecution";

// ── Type guards ─────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── Coercion helpers ────────────────────────────────────────────────

export function asString(value: unknown, fallback: string = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── Timestamps ──────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

// ── Error handling ──────────────────────────────────────────────────

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isEnoentError(error: unknown): boolean {
  return error != null && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT";
}

// ── Array helpers ───────────────────────────────────────────────────

export function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ── Async helpers ──────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Process helpers ────────────────────────────────────────────────

/** Extract the first non-empty line from a string. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

/**
 * `exitCode`/`signalCode` are part of the contract, not incidental: they are the
 * PID-reuse guard in `signalChildProcessTree`. A caller that hands over an
 * object without them would defeat that guard silently, so the type demands
 * them.
 */
type KillableChildProcess = Pick<
  ChildProcess,
  "pid" | "kill" | "stdin" | "stdout" | "stderr" | "exitCode" | "signalCode"
>;

function isValidPid(pid: number | null | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

export function destroyChildProcessStreams(child: Pick<KillableChildProcess, "stdin" | "stdout" | "stderr"> | null | undefined): void {
  if (!child) return;
  try {
    child.stdin?.destroy();
  } catch {
    // ignore
  }
  try {
    child.stdout?.destroy();
  } catch {
    // ignore
  }
  try {
    child.stderr?.destroy();
  } catch {
    // ignore
  }
}

/**
 * Signal a process tree instead of just the direct child.
 *
 * On Unix-like systems, the child is spawned into its own process group and we
 * signal the entire group. On Windows, `taskkill /T` is the closest equivalent.
 *
 * Windows note: `taskkill`'s exit code is not evidence that the tree died, in
 * either direction. Without `/F` it asks each window to close, so a windowless
 * console process reports 128 ("no running instance") while its children are
 * very much alive; a 0 only means the requests were dispatched. Treating 0 as
 * success used to skip the direct-child fallback entirely, and the fallback is
 * itself only a partial answer — `child.kill()` is `TerminateProcess` on the
 * leader alone and never touches descendants. So we always do both.
 *
 * The tree kill passes `/F` for EVERY signal, including SIGTERM. Deferring the
 * force to the caller's SIGKILL escalation cannot work: measured on Windows 11,
 * a non-forced `taskkill /PID <leader> /T` against a windowless console process
 * exits 128 and kills nothing, then `child.kill("SIGTERM")` — which is a plain
 * `TerminateProcess` on Windows, not a catchable signal — removes the leader.
 * By the time the escalation runs, `taskkill /PID <leader> /T /F` reports
 * `ERROR: The process "<pid>" not found.` and the descendants are unreachable
 * forever. Nothing is lost by forcing immediately, because the leader never had
 * a graceful path on Windows to begin with. This matches `terminateProcessTree`
 * in ./processExecution, which always forces for the same reason.
 *
 * An already-exited child is refused outright. This is the PID-reuse guard, not
 * an optimization: once Node reports `exitCode`/`signalCode` the pid has been
 * reaped and Windows recycles pids aggressively, so `taskkill /PID <pid> /T /F`
 * would force-kill whatever process now holds that number — and its whole tree.
 * The guard is unconditional rather than win32-only because `process.kill(-pid)`
 * against a recycled process group is the same hazard on POSIX; there is nothing
 * left to signal on either platform.
 */
export function signalChildProcessTree(child: KillableChildProcess, signal: NodeJS.Signals): boolean {
  // Coalesce through `?? null`: an ABSENT field means "not tracked", not
  // "already exited". A bare `!== null` reads `undefined` as exited and refuses
  // to kill, which silently leaks the whole tree — the exact failure this
  // function exists to prevent, and the more dangerous direction of the two.
  // Handles reach here through `as unknown as ChildProcess` casts that the type
  // cannot police, so only an explicit non-null value counts as proof the pid
  // was reaped.
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return false;
  const pid = child.pid ?? null;

  if (process.platform === "win32") {
    let treeSignaled = false;
    if (isValidPid(pid)) {
      const taskkillArgs = ["/PID", String(pid), "/T", "/F"];
      try {
        const result = spawnSync(windowsTaskkillCommand(), taskkillArgs, {
          stdio: "ignore",
          windowsHide: true,
        });
        treeSignaled = !result.error && result.status === 0;
      } catch {
        // taskkill may be unavailable; the direct child signal below still runs.
      }
    }
    let childSignaled = false;
    try {
      childSignaled = child.kill(signal);
    } catch {
      childSignaled = false;
    }
    return treeSignaled || childSignaled;
  }

  if (isValidPid(pid)) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // fall through to direct child signaling
    }
  }

  try {
    if (child.kill(signal)) return true;
  } catch {
    // fall through to PID signaling below
  }

  if (isValidPid(pid)) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * SIGTERM now, SIGKILL after `killAfterMs` if the child is still there.
 *
 * The delayed kill is safe against pid reuse because it re-reads the LIVE
 * `child` object: `signalChildProcessTree` refuses an exited child, so a child
 * that went away inside the grace window is never force-killed by pid — which
 * matters because 1.5s is ample time for Windows to hand that pid to someone
 * else. Callers that keep the returned timer should clear it on exit anyway, so
 * the timer does not hold the event loop open.
 */
export function terminateChildProcessTree(
  child: KillableChildProcess,
  previousKillTimer: NodeJS.Timeout | null = null,
  killAfterMs = 1_500,
): NodeJS.Timeout {
  if (previousKillTimer) {
    clearTimeout(previousKillTimer);
  }
  signalChildProcessTree(child, "SIGTERM");
  return setTimeout(() => {
    signalChildProcessTree(child, "SIGKILL");
  }, killAfterMs);
}

/** Spawn a child process and collect stdout/stderr with a timeout. */
export function spawnAsync(
  command: string,
  args: string[],
  opts?: { timeout?: number; maxOutputBytes?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const invocation = resolveCliSpawnInvocation(command, args);
      const child = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const limit = opts?.maxOutputBytes ?? 10_000;
      const timeoutMs = opts?.timeout ?? 5_000;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let hardResolveHandle: NodeJS.Timeout | null = null;
      let killEscalationHandle: NodeJS.Timeout | null = null;
      let settled = false;
      const settle = (status: number | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (hardResolveHandle) clearTimeout(hardResolveHandle);
        if (killEscalationHandle) clearTimeout(killEscalationHandle);
        destroyChildProcessStreams(child);
        resolve({ status, stdout, stderr });
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8").slice(0, Math.max(0, limit - stdout.length));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8").slice(0, Math.max(0, limit - stderr.length));
      });
      child.once("error", () => settle(null));
      child.once("close", (code) => settle(code));
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        // Retain the SIGKILL escalation timer so we can clear it if the
        // SIGTERM induces a clean exit before the kill window elapses.
        killEscalationHandle = terminateChildProcessTree(child, null, 1_500);
        hardResolveHandle = setTimeout(() => settle(null), 5_000);
      }, timeoutMs);
    } catch {
      resolve({ status: null, stdout: "", stderr: "" });
    }
  });
}

/** Resolve the absolute path of a command, or null if not found. */
export async function whichCommand(command: string): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      // ".exe" matters: spawnAsync wraps any extension-less command in
      // `cmd.exe /d /s /c`, and that wrapper costs ~15ms of pure overhead per
      // lookup on top of the ~58ms the lookup itself takes.
      const res = await spawnAsync("where.exe", [command]);
      if (res.status !== 0) return null;
      const line = firstLine(res.stdout ?? "");
      return line.length ? line : null;
    }
    // Always use a POSIX shell here so user-configured shells cannot change the
    // semantics of the `command -v` lookup.
    const lookupShell = "/bin/sh";
    const res = await spawnAsync(lookupShell, ["-lc", 'command -v "$1" 2>/dev/null || true', "--", command]);
    const line = firstLine(res.stdout ?? "");
    return line.length ? line : null;
  } catch {
    return null;
  }
}

// ── Git helpers ─────────────────────────────────────────────────────

export function parseDiffNameOnly(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ── Safe JSON parsing ───────────────────────────────────────────────

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Path helpers ────────────────────────────────────────────────────

/** Returns true if `candidate` is equal to or nested inside `root`. */
export function isWithinDir(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathExisting(filePath: string): string {
  return typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
}

function candidateExpressionFromRoot(root: string, candidate: string): string {
  const normalizedRoot = path.resolve(root);
  if (path.isAbsolute(candidate)) return candidate;
  if (!candidate.length) return normalizedRoot;
  return normalizedRoot.endsWith(path.sep)
    ? `${normalizedRoot}${candidate}`
    : `${normalizedRoot}${path.sep}${candidate}`;
}

function splitPathSegments(filePath: string): { root: string; segments: string[] } {
  const parsed = path.parse(filePath);
  const remainder = filePath.slice(parsed.root.length);
  return {
    root: parsed.root,
    segments: remainder.split(/[\\/]+/).filter((segment) => segment.length > 0),
  };
}

function pathEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object"
      ? ("code" in error ? (error as NodeJS.ErrnoException).code : undefined)
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function resolveCandidatePath(
  root: string,
  candidate: string,
  opts: { allowMissing?: boolean } = {},
): string {
  const expression = candidateExpressionFromRoot(root, candidate);
  const { root: candidateRoot, segments } = splitPathSegments(expression);
  let cursor = candidateRoot;

  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      cursor = path.dirname(cursor);
      continue;
    }
    const nextPath = path.join(cursor, segment);
    if (pathEntryExists(nextPath)) {
      cursor = realpathExisting(nextPath);
      continue;
    }
    if (!opts.allowMissing) {
      throw new Error(`Path does not exist: ${candidate}`);
    }
    cursor = nextPath;
  }

  return cursor;
}

/**
 * Resolve `candidate` against the real filesystem layout and ensure it stays
 * inside `root`, even when symlinks are involved.
 */
export function resolvePathWithinRoot(
  root: string,
  candidate: string,
  opts: { allowMissing?: boolean } = {},
): string {
  const rootReal = realpathExisting(path.resolve(root));
  const candidateReal = resolveCandidatePath(root, candidate, opts);
  if (!isWithinDir(rootReal, candidateReal)) {
    throw new Error("Path escapes root");
  }
  return candidateReal;
}

function openReadOnlyNoFollow(filePath: string): number {
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  return fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
}

function openWriteNoFollow(filePath: string, flags: number, mode: number): number {
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  return fs.openSync(filePath, flags | noFollowFlag, mode);
}

function isPathAlignedWithRoot(rootReal: string, candidatePath: string): boolean {
  return isWithinDir(candidatePath, rootReal) || isWithinDir(rootReal, candidatePath);
}

function ensureDirectoryChainWithinRoot(
  rootReal: string,
  candidate: string,
  opts: { createMissing?: boolean } = {},
): string {
  const { root: candidateRoot, segments } = splitPathSegments(candidate);
  let cursor = realpathExisting(candidateRoot);

  if (!isPathAlignedWithRoot(rootReal, cursor)) {
    throw new Error("Path escapes root");
  }

  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      cursor = path.dirname(cursor);
      if (!isPathAlignedWithRoot(rootReal, cursor)) {
        throw new Error("Path escapes root");
      }
      continue;
    }

    const nextPath = path.join(cursor, segment);
    try {
      fs.lstatSync(nextPath);
      const resolvedPath = realpathExisting(nextPath);
      if (!isPathAlignedWithRoot(rootReal, resolvedPath)) {
        throw new Error("Path escapes root");
      }
      if (!fs.statSync(resolvedPath).isDirectory()) {
        throw new Error(`Path is not a directory: ${nextPath}`);
      }
      cursor = resolvedPath;
    } catch (error) {
      const code = error && typeof error === "object"
        ? ("code" in error ? (error as NodeJS.ErrnoException).code : undefined)
        : undefined;
      if (code !== "ENOENT" || !opts.createMissing) {
        throw error;
      }
      if (!isPathAlignedWithRoot(rootReal, nextPath)) {
        throw new Error("Path escapes root");
      }
      fs.mkdirSync(nextPath);
      const createdPath = realpathExisting(nextPath);
      if (!isPathAlignedWithRoot(rootReal, createdPath)) {
        throw new Error("Path escapes root");
      }
      cursor = createdPath;
    }
  }

  return cursor;
}

function prepareMutationTargetWithinRoot(
  root: string,
  candidate: string,
): { rootReal: string; parentPath: string; targetPath: string } {
  const rootReal = realpathExisting(path.resolve(root));
  const expression = candidateExpressionFromRoot(root, candidate);
  const parentExpression = path.dirname(expression);
  const parentPath = ensureDirectoryChainWithinRoot(rootReal, parentExpression, { createMissing: true });
  const targetPath = path.join(parentPath, path.basename(expression));
  if (!isWithinDir(rootReal, targetPath)) {
    throw new Error("Path escapes root");
  }
  return { rootReal, parentPath, targetPath };
}

function writeFileByDescriptor(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: fs.WriteFileOptions | BufferEncoding,
): void {
  const mode = typeof options === "object" && options != null && typeof options.mode === "number"
    ? options.mode
    : 0o666;
  const fd = openWriteNoFollow(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, mode);
  try {
    fs.writeFileSync(fd, data, options as fs.WriteFileOptions | BufferEncoding | undefined);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Re-resolve and validate a file at open time, then read it through the file
 * descriptor so callers do not rely on a previously checked path string.
 */
export type DirtyFileTextLookup = (
  absPath: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Read file bytes for agent/tool consumption, preferring unsaved editor buffers
 * from the renderer when available.
 */
export async function readAgentAccessibleFileBytes(args: {
  rootPath: string;
  resolvedPath: string;
  getDirtyFileTextForPath?: DirtyFileTextLookup;
}): Promise<Buffer> {
  const root = path.resolve(args.rootPath);
  let absPath: string;
  try {
    absPath = resolvePathWithinRoot(root, args.resolvedPath, { allowMissing: false });
  } catch {
    return readFileWithinRootSecure(root, args.resolvedPath);
  }

  if (args.getDirtyFileTextForPath) {
    try {
      const dirty = await Promise.resolve(args.getDirtyFileTextForPath(absPath));
      if (typeof dirty === "string") {
        return Buffer.from(dirty, "utf8");
      }
    } catch {
      // Fall back to on-disk content when renderer lookup fails.
    }
  }

  return readFileWithinRootSecure(root, absPath);
}

export function readFileWithinRootSecure(root: string, candidate: string): Buffer {
  let expectedPath: string;
  try {
    expectedPath = resolvePathWithinRoot(root, candidate, { allowMissing: false });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Path does not exist:")) {
      const missing = new Error(error.message) as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    }
    throw error;
  }
  const fd = openReadOnlyNoFollow(expectedPath);
  try {
    const openStat = fs.fstatSync(fd);
    if (!openStat.isFile()) {
      throw new Error("Path is not a regular file");
    }
    const currentPath = resolvePathWithinRoot(root, expectedPath, { allowMissing: false });
    const currentStat = fs.statSync(currentPath);
    if (openStat.dev !== currentStat.dev || openStat.ino !== currentStat.ino) {
      throw new Error("Path changed during open");
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function secureMkdirWithinRoot(root: string, candidate: string): string {
  const rootReal = realpathExisting(path.resolve(root));
  const expression = candidateExpressionFromRoot(root, candidate);
  return ensureDirectoryChainWithinRoot(rootReal, expression, { createMissing: true });
}

export function secureWriteFileWithinRoot(
  root: string,
  candidate: string,
  data: string | NodeJS.ArrayBufferView,
  options?: fs.WriteFileOptions | BufferEncoding,
): string {
  const { targetPath } = prepareMutationTargetWithinRoot(root, candidate);
  writeFileByDescriptor(targetPath, data, options);
  return targetPath;
}

export function secureWriteTextAtomicWithinRoot(root: string, candidate: string, text: string): string {
  const initialTarget = prepareMutationTargetWithinRoot(root, candidate);
  const tmpPath = path.join(
    initialTarget.parentPath,
    `.${path.basename(initialTarget.targetPath) || "tmp"}.${randomUUID()}.tmp`,
  );
  writeFileByDescriptor(tmpPath, text, "utf8");
  try {
    const { targetPath } = prepareMutationTargetWithinRoot(root, candidate);
    fs.renameSync(tmpPath, targetPath);
    return targetPath;
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

export function secureCopyFileIntoRoot(root: string, candidate: string, sourcePath: string): string {
  const initialTarget = prepareMutationTargetWithinRoot(root, candidate);
  const tmpPath = path.join(
    initialTarget.parentPath,
    `.${path.basename(initialTarget.targetPath) || "tmp"}.${randomUUID()}.tmp`,
  );
  fs.copyFileSync(sourcePath, tmpPath);
  try {
    const { targetPath } = prepareMutationTargetWithinRoot(root, candidate);
    fs.renameSync(tmpPath, targetPath);
    return targetPath;
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

export function secureCopyPathIntoRoot(root: string, candidate: string, sourcePath: string): string {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const targetPath = secureMkdirWithinRoot(root, candidate);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      secureCopyPathIntoRoot(root, path.join(candidate, entry.name), path.join(sourcePath, entry.name));
    }
    return targetPath;
  }
  return secureCopyFileIntoRoot(root, candidate, sourcePath);
}

export function secureRenameWithinRoot(root: string, sourceCandidate: string, targetCandidate: string): {
  sourcePath: string;
  targetPath: string;
} {
  const sourcePath = resolvePathWithinRoot(root, sourceCandidate, { allowMissing: false });
  const { targetPath } = prepareMutationTargetWithinRoot(root, targetCandidate);
  fs.renameSync(sourcePath, targetPath);
  return { sourcePath, targetPath };
}

// ── String helpers ──────────────────────────────────────────────────

/** Return trimmed string or null if empty/non-string. */
export function toOptionalString(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

// ── File helpers ────────────────────────────────────────────────────

/**
 * Write text to a file atomically (write to tmp, rename). Pass `mode` (e.g.
 * `0o600`) to create the temp file with restrictive perms from the start —
 * important for secrets, which must never exist world-readable even briefly.
 */
export function writeTextAtomic(filePath: string, text: string, options?: { mode?: number }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, text, options?.mode != null ? { encoding: "utf8", mode: options.mode } : "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup errors
      }
      throw error;
    }
  }
}

/** Return file size or 0 if the file doesn't exist. */
export function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ── Filesystem existence checks ─────────────────────────────────────

export function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read at most `maxBytes` from a file. Returns empty string on any error.
 */
export function safeReadText(absPath: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.slice(0, Math.max(0, read)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ── Path normalization ─────────────────────────────────────────────

/** Normalize a relative path to forward slashes, strip leading "./" or "/". */
export function normalizeRelative(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

// ── Binary detection ───────────────────────────────────────────────

/** Strip refs/heads/ and origin/ prefixes from a branch name. */
export function normalizeBranchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

/** Returns true if the buffer contains a null byte in the first 8192 bytes. */
export function hasNullByte(buf: Buffer): boolean {
  const max = Math.min(buf.length, 8192);
  for (let i = 0; i < max; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ── Date/time helpers ───────────────────────────────────────────────

/** Parse ISO string to epoch ms, or NaN if invalid/missing. */
export function parseIsoToEpoch(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

// ── Hashing helpers ─────────────────────────────────────────────────

/** SHA-256 hex digest of a string or Buffer. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON.stringify with sorted keys (deep). */
export function stableStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((entry) => normalize(entry));
    if (input && typeof input === "object") {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        next[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return next;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

// ── Base64url / PKCE helpers ─────────────────────────────────────────

/** Encode a Buffer to a base64url string (no padding). */
export function toBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Generate a PKCE verifier/challenge pair using SHA-256. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(48));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── Glob / pattern matching ─────────────────────────────────────────

export function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim();
  if (!normalized.length) return /^$/;
  const parts = normalized.split("*").map((chunk) => escapeRegExp(chunk));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}

export function matchesGlob(pattern: string | null | undefined, value: string | null | undefined): boolean {
  const expected = (pattern ?? "").trim();
  if (!expected) return true;
  const actual = (value ?? "").trim();
  if (!actual) return false;
  return globToRegExp(expected).test(actual);
}

export function normalizeSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

// ── Template rendering helpers ──────────────────────────────────────

/** Walk a dotted path like "a.b.c" into a nested object. */
export function getPathValue(source: Record<string, unknown>, dottedPath: string): unknown {
  const segments = dottedPath
    .split(".")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (segments.length === 0) return null;
  let cursor: unknown = source;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Render {{ path }} placeholders against a values object. */
export function renderTemplateString(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath) => {
    const value = getPathValue(values, String(rawPath));
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry)).join(", ");
    }
    return JSON.stringify(value);
  });
}

// ── Text clipping helpers ──────────────────────────────────────────

/** Clip text to `maxLength`, appending an ellipsis if truncated. */
export function clipText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

// ── Secret detection helpers ────────────────────────────────────────

const ENV_REF_PATTERN = /^\$\{env:[A-Z0-9_]+\}$/;
const ENV_REF_TOKEN_PATTERN = /\$\{env:[A-Z0-9_]+\}/;

export function isEnvRef(value: string): boolean {
  return ENV_REF_PATTERN.test(value.trim());
}

export function hasEnvRefToken(value: string): boolean {
  return ENV_REF_TOKEN_PATTERN.test(value);
}

/**
 * Redact common secret patterns from a plain-text string.
 *
 * This complements `sanitizeStructuredData` (which operates on parsed objects)
 * by scrubbing raw output text before it is persisted in logs or result_json.
 */
export function redactSecrets(text: string, replacement: string = "[REDACTED]"): string {
  if (!text) return text;
  return text
    // Bearer tokens
    .replace(/\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement)
    // OpenAI / Anthropic-style keys
    .replace(/\bsk-[A-Za-z0-9]{12,}\b/g, replacement)
    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement)
    // Slack tokens
    .replace(/\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, replacement)
    // AWS access keys
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement)
    // GitHub fine-grained PATs (github_pat_...)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement)
    // JSON-style sensitive keys: "apiKey":"...", "token":"...", "secret":"...", etc.
    .replace(/"(api[_-]?key|secret|token|password|authorization)"\s*:\s*"[^"]{4,}"/gi, `"$1":"${replacement}"`)
    // Generic high-entropy hex/base64 secrets assigned to common key names
    .replace(/(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{16,}["']?/gi, `$1=${replacement}`);
}

export function looksSensitiveKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|authorization)/i.test(key);
}

export function looksSensitiveValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.length) return false;
  if (/^bearer\s+/i.test(trimmed)) return true;
  if (/^sk-[a-z0-9]{12,}/i.test(trimmed)) return true;
  if (/^gh[pousr]_[a-z0-9]{20,}/i.test(trimmed)) return true;
  if (/^xox[baprs]-[a-z0-9-]{10,}/i.test(trimmed)) return true;
  if (/api[_-]?key|secret|token|password/i.test(trimmed)) return true;
  return false;
}

export type SanitizeStructuredDataOptions = {
  blockedTopLevelKeys?: Iterable<string>;
  maxArrayEntries?: number;
  maxObjectEntries?: number;
  maxStringLength?: number;
  redactionText?: string;
};

export function sanitizeStructuredData(
  input: unknown,
  options: SanitizeStructuredDataOptions = {},
): Record<string, unknown> | null {
  if (!isRecord(input)) return null;

  const blockedTopLevelKeys = new Set(
    Array.from(options.blockedTopLevelKeys ?? [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const maxArrayEntries = Math.max(1, Math.floor(options.maxArrayEntries ?? 50));
  const maxObjectEntries = Math.max(1, Math.floor(options.maxObjectEntries ?? 50));
  const maxStringLength = Math.max(32, Math.floor(options.maxStringLength ?? 4_000));
  const redactionText = options.redactionText ?? "[REDACTED]";

  const clipString = (value: string): string => {
    if (value.length <= maxStringLength) return value;
    return `${value.slice(0, maxStringLength - 1)}…`;
  };

  const seen = new WeakSet<object>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      return value.slice(0, maxArrayEntries).map((entry) => walk(entry));
    }
    if (isRecord(value)) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const next: Record<string, unknown> = {};
      for (const [index, [key, child]] of Object.entries(value).entries()) {
        if (index >= maxObjectEntries) break;
        if (looksSensitiveKey(key)) {
          next[key] = redactionText;
          continue;
        }
        next[key] = walk(child);
      }
      return next;
    }
    if (typeof value === "string") {
      if (looksSensitiveValue(value)) return redactionText;
      return clipString(value);
    }
    return value;
  };

  const sanitized: Record<string, unknown> = {};
  for (const [index, [key, value]] of Object.entries(input).entries()) {
    if (index >= maxObjectEntries) break;
    if (blockedTopLevelKeys.has(key.toLowerCase())) continue;
    if (looksSensitiveKey(key)) {
      sanitized[key] = redactionText;
      continue;
    }
    sanitized[key] = walk(value);
  }
  return sanitized;
}
