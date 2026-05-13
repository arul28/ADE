import fs from "node:fs";
import path from "node:path";
import type { createLaneService } from "../lanes/laneService";
import { runGit } from "../git/git";
import { resolvePathWithinRoot } from "../shared/utils";
import type { DiffChanges, DiffLineStats, DiffMode, FileDiff, FileChange, FilePatch } from "../../../shared/types";

export const MAX_DIFF_SIDE_TEXT_BYTES = 192 * 1024;
export const MAX_DIFF_PATCH_BYTES = 512 * 1024;
export const DIFF_TRUNCATION_NOTICE = "\n\n[Preview truncated. Open the file externally or in Files for the full content.]\n";

export function appendDiffTruncationNotice(text: string): string {
  return `${text.replace(/\s*$/, "")}${DIFF_TRUNCATION_NOTICE}`;
}

function parseStatusKind(code: string): FileChange["kind"] {
  if (code === "??") return "untracked";
  const c = code.replace(/[^A-Z]/g, "");
  if (c.includes("R")) return "renamed";
  if (c.includes("D")) return "deleted";
  if (c.includes("A")) return "added";
  if (c.includes("M")) return "modified";
  return "unknown";
}

function parseStatusColumnKind(column: string): FileChange["kind"] | null {
  if (column === "R") return "renamed";
  if (column === "D") return "deleted";
  if (column === "A") return "added";
  if (column === "M") return "modified";
  if (column === "?") return "untracked";
  return null;
}

function stripGitStatusPath(raw: string): string {
  // Handles rename format: "old -> new"
  const idx = raw.indexOf("->");
  if (idx >= 0) return raw.slice(idx + 2).trim();
  return raw.trim();
}

function parseNumstatZ(stdout: string): Array<{ addRaw: string; delRaw: string; filePath: string }> {
  const entries: Array<{ addRaw: string; delRaw: string; filePath: string }> = [];
  const records = stdout.split("\0");

  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (!record) continue;

    const [addRaw, delRaw, ...pathParts] = record.split("\t");
    if (addRaw == null || delRaw == null || pathParts.length === 0) continue;

    let filePath = pathParts.join("\t");
    if (!filePath) {
      filePath = records[i + 2] ?? "";
      i += 2;
    }
    if (!filePath) continue;

    entries.push({ addRaw, delRaw, filePath });
  }

  return entries;
}

function parsePorcelainStatusZ(stdout: string): DiffChanges {
  const unstaged: FileChange[] = [];
  const staged: FileChange[] = [];
  const records = stdout.split("\0").filter(Boolean);

  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.length < 3) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const code = `${x}${y}`;
    const p = stripGitStatusPath(record.slice(3));
    if (!p) continue;

    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const previous = records[i + 1];
      if (previous) {
        oldPath = previous;
        i += 1;
      }
    }

    if (code === "??") {
      unstaged.push({ path: p, kind: "untracked" });
      continue;
    }

    const stagedKind = parseStatusColumnKind(x) ?? parseStatusKind(code);
    const unstagedKind = parseStatusColumnKind(y) ?? parseStatusKind(code);
    if (x !== " " && x !== "?") {
      staged.push(oldPath && stagedKind === "renamed" ? { path: p, oldPath, kind: stagedKind } : { path: p, kind: stagedKind });
    }
    if (y !== " " && y !== "?") {
      unstaged.push(oldPath && unstagedKind === "renamed" ? { path: p, oldPath, kind: unstagedKind } : { path: p, kind: unstagedKind });
    }
  }

  return { unstaged, staged };
}

function applyNumstat(changes: FileChange[], stdout: string): void {
  const byPath = new Map(changes.map((change) => [change.path, change]));
  for (const { addRaw, delRaw, filePath } of parseNumstatZ(stdout)) {
    const change = byPath.get(filePath);
    if (!change) continue;
    const additions = Number.parseInt(addRaw, 10);
    const deletions = Number.parseInt(delRaw, 10);
    if (Number.isFinite(additions)) change.additions = additions;
    if (Number.isFinite(deletions)) change.deletions = deletions;
    if (addRaw === "-" || delRaw === "-") change.isBinary = true;
  }
}

function emptyDiffLineStats(): DiffLineStats {
  return { additions: 0, deletions: 0, files: 0 };
}

function parseShortstat(stdout: string): DiffLineStats {
  const text = stdout.trim();
  if (!text) return emptyDiffLineStats();

  const parseCount = (pattern: RegExp): number =>
    Number.parseInt(text.match(pattern)?.[1] ?? "0", 10);

  return {
    additions: parseCount(/(\d+)\s+insertions?\(\+\)/i),
    deletions: parseCount(/(\d+)\s+deletions?\(-\)/i),
    files: parseCount(/(\d+)\s+files?\s+changed/i),
  };
}

function readLaneCompareRef(baseRef: string): string | null {
  const ref = baseRef.trim();
  if (!ref || ref.startsWith("-")) return null;
  return `${ref}...HEAD`;
}

function readLaneIdArg(value: string | { laneId?: string } | null | undefined): string {
  let laneId = "";
  if (typeof value === "string") {
    laneId = value;
  } else if (typeof value?.laneId === "string") {
    laneId = value.laneId;
  }
  const trimmed = laneId.trim();
  if (!trimmed) {
    throw new Error("laneId is required");
  }
  return trimmed;
}

function detectBinary(buf: Buffer): boolean {
  // Simple heuristic: null byte indicates binary.
  return buf.includes(0);
}

function readTextFileSafe(absPath: string, maxBytes: number): {
  exists: boolean;
  text: string;
  isBinary?: boolean;
  isTruncated?: boolean;
  size?: number;
} {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { exists: false, text: "" };
    const size = stat.size;
    const toRead = Math.min(size, maxBytes);
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (detectBinary(buf)) return { exists: true, text: "", isBinary: true };
      const text = buf.toString("utf8");
      const isTruncated = size > maxBytes;
      return { exists: true, text: isTruncated ? appendDiffTruncationNotice(text) : text, isTruncated, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exists: false, text: "" };
  }
}

async function gitShowText(
  cwd: string,
  spec: string,
  maxBytes: number
): Promise<{ exists: boolean; text: string; isBinary?: boolean; isTruncated?: boolean; size?: number }> {
  const res = await runGit(["show", spec], {
    cwd,
    timeoutMs: 10_000,
    maxOutputBytes: maxBytes + 64 * 1024
  });
  if (res.exitCode !== 0) return { exists: false, text: "" };
  const buf = Buffer.from(res.stdout, "utf8");
  if (detectBinary(buf)) return { exists: true, text: "", isBinary: true };
  if (buf.length > maxBytes) {
    return {
      exists: true,
      text: appendDiffTruncationNotice(buf.subarray(0, maxBytes).toString("utf8")),
      isTruncated: true,
      size: buf.length,
    };
  }
  return { exists: true, text: res.stdout, size: buf.length };
}

function parsePatchSummary(patch: string, fallbackPath: string): Pick<FilePatch, "oldPath" | "path" | "status" | "isBinary" | "additions" | "deletions"> {
  let currentPath = fallbackPath;
  let oldPath: string | undefined;
  let status: FileChange["kind"] = "modified";
  let additions = 0;
  let deletions = 0;
  let isBinary = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("rename from ")) {
      oldPath = line.slice("rename from ".length).trim();
      status = "renamed";
    } else if (line.startsWith("rename to ")) {
      currentPath = line.slice("rename to ".length).trim() || currentPath;
      status = "renamed";
    } else if (line.startsWith("new file mode ")) {
      status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      status = "deleted";
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true;
    } else if (line.startsWith("+++ b/")) {
      const next = line.slice("+++ b/".length).trim();
      if (next && next !== "/dev/null") currentPath = next;
    } else if (line.startsWith("--- a/")) {
      const prev = line.slice("--- a/".length).trim();
      if (prev && prev !== "/dev/null") oldPath = prev;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return {
    path: currentPath,
    ...(oldPath && oldPath !== currentPath ? { oldPath } : {}),
    status,
    isBinary,
    additions,
    deletions
  };
}

async function getCommitParentRef(cwd: string, ref: string): Promise<string | null> {
  const parentsRes = await runGit(["rev-list", "--parents", "-n", "1", ref], { cwd, timeoutMs: 10_000 });
  const parentSha = parentsRes.exitCode === 0 ? parentsRes.stdout.trim().split(" ").slice(1)[0] : undefined;
  return parentSha?.trim() ? parentSha.trim() : null;
}

function readCommitCompareRef(compareRef: string | undefined): string {
  const ref = compareRef?.trim();
  if (!ref) {
    throw new Error("compareRef is required for commit mode");
  }
  if (ref.startsWith("-")) {
    throw new Error("compareRef cannot start with '-'");
  }
  return ref;
}

function resolveGitFilePath(worktreePath: string, filePath: string): { absPath: string; gitPath: string } {
  if (!filePath.trim()) {
    throw new Error("File path is required");
  }
  if (filePath.includes("\0")) {
    throw new Error("File path contains an invalid null byte");
  }
  const root = fs.realpathSync(worktreePath);
  const absPath = resolvePathWithinRoot(root, filePath, { allowMissing: true });
  const gitPath = path.relative(root, absPath).replace(/\\/g, "/");
  if (!gitPath || gitPath.startsWith("../") || gitPath === "..") {
    throw new Error("Path escapes root");
  }
  return { absPath, gitPath };
}

export function createDiffService({ laneService }: { laneService: ReturnType<typeof createLaneService> }) {
  const getLaneDiffStats = async (laneIdArg: string | { laneId?: string } | null | undefined): Promise<DiffLineStats> => {
    const laneId = readLaneIdArg(laneIdArg);
    const { baseRef, worktreePath } = laneService.getLaneBaseAndBranch(laneId);
    const compareRef = readLaneCompareRef(baseRef);
    if (!compareRef) return emptyDiffLineStats();

    const res = await runGit(["diff", "--shortstat", "--find-renames", compareRef], {
      cwd: worktreePath,
      env: { LANG: "C", LC_ALL: "C" },
      timeoutMs: 12_000,
      maxOutputBytes: 64 * 1024,
    });
    if (res.exitCode !== 0) return emptyDiffLineStats();
    return parseShortstat(res.stdout);
  };

  return {
    getLaneDiffStats,

    async listLaneDiffStats(args: { laneIds?: string[] } = {}): Promise<Record<string, DiffLineStats>> {
      const requested = new Set((args.laneIds ?? []).map((id) => id.trim()).filter(Boolean));
      const lanes = await laneService.list({ includeArchived: false });
      const eligible = lanes.filter((lane) => requested.size === 0 || requested.has(lane.id));
      const entries = await Promise.all(eligible.map(async (lane) => {
        try {
          const stats = await getLaneDiffStats(lane.id);
          return [lane.id, stats] as const;
        } catch {
          return [lane.id, emptyDiffLineStats()] as const;
        }
      }));
      return Object.fromEntries(entries);
    },

    async getChanges(laneId: string): Promise<DiffChanges> {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const res = await runGit(["status", "--porcelain=v1", "-z"], { cwd: worktreePath, timeoutMs: 12_000 });
      if (res.exitCode !== 0) {
        return { unstaged: [], staged: [] };
      }

      const changes = parsePorcelainStatusZ(res.stdout);
      const [unstagedStats, stagedStats] = await Promise.all([
        runGit(["diff", "--numstat", "--find-renames", "-z"], { cwd: worktreePath, timeoutMs: 12_000, maxOutputBytes: 512 * 1024 }),
        runGit(["diff", "--cached", "--numstat", "--find-renames", "-z"], { cwd: worktreePath, timeoutMs: 12_000, maxOutputBytes: 512 * 1024 }),
      ]);
      if (unstagedStats.exitCode === 0) applyNumstat(changes.unstaged, unstagedStats.stdout);
      if (stagedStats.exitCode === 0) applyNumstat(changes.staged, stagedStats.stdout);

      return changes;
    },

    async getFileDiff({
      laneId,
      filePath,
      mode,
      compareRef,
      compareTo
    }: {
      laneId: string;
      filePath: string;
      mode: DiffMode;
      compareRef?: string;
      compareTo?: "worktree" | "parent";
    }): Promise<FileDiff> {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const { absPath, gitPath } = resolveGitFilePath(worktreePath, filePath);

      if (mode === "staged") {
        const head = await gitShowText(worktreePath, `HEAD:${gitPath}`, MAX_DIFF_SIDE_TEXT_BYTES);
        const idx = await gitShowText(worktreePath, `:${gitPath}`, MAX_DIFF_SIDE_TEXT_BYTES);
        const isBinary = Boolean(head.isBinary || idx.isBinary);
        return {
          path: gitPath,
          mode,
          original: { exists: head.exists, text: head.text, size: head.size, isTruncated: head.isTruncated },
          modified: { exists: idx.exists, text: idx.text, size: idx.size, isTruncated: idx.isTruncated },
          ...(isBinary ? { isBinary: true } : {})
        };
      }

      if (mode === "commit") {
        const ref = readCommitCompareRef(compareRef);
        const target = compareTo ?? "worktree";

        if (target === "parent") {
          const parentRef = await getCommitParentRef(worktreePath, ref);
          const parentSide = parentRef ? await gitShowText(worktreePath, `${parentRef}:${gitPath}`, MAX_DIFF_SIDE_TEXT_BYTES) : { exists: false, text: "" };
          const commitSide = await gitShowText(worktreePath, `${ref}:${gitPath}`, MAX_DIFF_SIDE_TEXT_BYTES);
          const isBinary = Boolean(parentSide.isBinary || commitSide.isBinary);
          return {
            path: gitPath,
            mode,
            original: { exists: parentSide.exists, text: parentSide.text, size: parentSide.size, isTruncated: parentSide.isTruncated },
            modified: { exists: commitSide.exists, text: commitSide.text, size: commitSide.size, isTruncated: commitSide.isTruncated },
            ...(isBinary ? { isBinary: true } : {})
          };
        }

        const commitSide = await gitShowText(worktreePath, `${ref}:${gitPath}`, MAX_DIFF_SIDE_TEXT_BYTES);
        const wt = readTextFileSafe(absPath, MAX_DIFF_SIDE_TEXT_BYTES);
        const isBinary = Boolean(commitSide.isBinary || wt.isBinary);
        return {
          path: gitPath,
          mode,
          original: { exists: commitSide.exists, text: commitSide.text, size: commitSide.size, isTruncated: commitSide.isTruncated },
          modified: { exists: wt.exists, text: wt.text, size: wt.size, isTruncated: wt.isTruncated },
          ...(isBinary ? { isBinary: true } : {})
        };
      }

      // Unstaged: index -> working tree
      const idx = await gitShowText(worktreePath, `:${gitPath}`, MAX_DIFF_SIDE_TEXT_BYTES);
      const wt = readTextFileSafe(absPath, MAX_DIFF_SIDE_TEXT_BYTES);
      const isBinary = Boolean(idx.isBinary || wt.isBinary);
      return {
        path: gitPath,
        mode,
        original: { exists: idx.exists, text: idx.text, size: idx.size, isTruncated: idx.isTruncated },
        modified: { exists: wt.exists, text: wt.text, size: wt.size, isTruncated: wt.isTruncated },
        ...(isBinary ? { isBinary: true } : {})
      };
    },

    async getFilePatch({
      laneId,
      filePath,
      mode,
      compareRef,
      compareTo
    }: {
      laneId: string;
      filePath: string;
      mode: DiffMode;
      compareRef?: string;
      compareTo?: "worktree" | "parent";
    }): Promise<FilePatch> {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const { gitPath } = resolveGitFilePath(worktreePath, filePath);
      let args: string[];

      if (mode === "staged") {
        args = ["diff", "--cached", "--no-ext-diff", "--find-renames", "--patch", "--", gitPath];
      } else if (mode === "commit") {
        const ref = readCommitCompareRef(compareRef);
        const target = compareTo ?? "worktree";
        if (target === "parent") {
          const parentRef = await getCommitParentRef(worktreePath, ref);
          args = parentRef
            ? ["diff", "--no-ext-diff", "--find-renames", "--patch", parentRef, ref, "--", gitPath]
            : ["show", "--format=", "--no-ext-diff", "--find-renames", "--patch", ref, "--", gitPath];
        } else {
          args = ["diff", "--no-ext-diff", "--find-renames", "--patch", ref, "--", gitPath];
        }
      } else {
        args = ["diff", "--no-ext-diff", "--find-renames", "--patch", "--", gitPath];
      }

      const res = await runGit(args, {
        cwd: worktreePath,
        timeoutMs: 12_000,
        maxOutputBytes: MAX_DIFF_PATCH_BYTES
      });
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `git ${args.join(" ")} failed`);
      }

      return {
        mode,
        patch: res.stdout,
        size: Buffer.byteLength(res.stdout, "utf8"),
        isTruncated: res.stdoutTruncated || undefined,
        ...parsePatchSummary(res.stdout, gitPath)
      };
    }
  };
}
