import { spawn } from "node:child_process";
import type { ConflictFileType } from "../../../shared/types";

export type GitRunOptions = {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type GitRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
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

export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return await new Promise<GitRunResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ exitCode: 124, stdout, stderr: stderr.length ? stderr : "git timed out" });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    child.on("close", (code) => {
      clearTimeout(onTimeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
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
