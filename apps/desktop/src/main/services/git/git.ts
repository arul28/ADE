import { spawn } from "node:child_process";
import type { ConflictFileType } from "../../../shared/types";

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
  usedWriteTree: boolean;
};

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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

export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = Number.isFinite(opts.maxOutputBytes)
    ? Math.max(0, Math.floor(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES))
    : DEFAULT_MAX_OUTPUT_BYTES;

  return await new Promise<GitRunResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

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
      resolve(result);
    };

    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
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
      finish({
        exitCode: 1,
        stdout,
        stderr: stderr.length ? stderr : error.message,
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

export async function runGitOrThrow(args: string[], opts: GitRunOptions): Promise<string> {
  const res = await runGit(args, opts);
  if (res.exitCode !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(msg);
  }
  return res.stdout;
}

function normalizeConflictType(raw: string): ConflictFileType {
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

function shouldFallbackFromWriteTree(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("unable to create temporary file") ||
    text.includes("failure to merge") ||
    text.includes("unknown option") ||
    text.includes("usage: git merge-tree")
  );
}

export async function runGitMergeTree(args: {
  cwd: string;
  mergeBase: string;
  branchA: string;
  branchB: string;
  timeoutMs?: number;
}): Promise<GitMergeTreeResult> {
  const timeoutMs = args.timeoutMs ?? 45_000;
  const writeTreeCmd = [
    "merge-tree",
    "--write-tree",
    "--messages",
    "--merge-base",
    args.mergeBase,
    args.branchA,
    args.branchB
  ];

  const writeTree = await runGit(writeTreeCmd, { cwd: args.cwd, timeoutMs });
  if (!(writeTree.exitCode !== 0 && shouldFallbackFromWriteTree(writeTree.stderr))) {
    const combined = `${writeTree.stdout}\n${writeTree.stderr}`;
    return {
      ...writeTree,
      mergeBase: args.mergeBase,
      branchA: args.branchA,
      branchB: args.branchB,
      conflicts: parseMergeTreeConflicts(combined),
      usedWriteTree: true
    };
  }

  const fallbackCmd = ["merge-tree", args.mergeBase, args.branchA, args.branchB];
  const fallback = await runGit(fallbackCmd, { cwd: args.cwd, timeoutMs });
  const combined = `${fallback.stdout}\n${fallback.stderr}`;
  return {
    ...fallback,
    mergeBase: args.mergeBase,
    branchA: args.branchA,
    branchB: args.branchB,
    conflicts: parseMergeTreeConflicts(combined),
    usedWriteTree: false
  };
}
