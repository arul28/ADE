import fs from "node:fs";
import path from "node:path";
import type { createLaneService } from "../lanes/laneService";
import { runGit } from "../git/git";
import type { DiffChanges, DiffMode, FileDiff, FileChange } from "../../../shared/types";

function parseStatusKind(code: string): FileChange["kind"] {
  if (code === "??") return "untracked";
  const c = code.replace(/[^A-Z]/g, "");
  if (c.includes("M")) return "modified";
  if (c.includes("A")) return "added";
  if (c.includes("D")) return "deleted";
  if (c.includes("R")) return "renamed";
  return "unknown";
}

function stripGitStatusPath(raw: string): string {
  // Handles rename format: "old -> new"
  const idx = raw.indexOf("->");
  if (idx >= 0) return raw.slice(idx + 2).trim();
  return raw.trim();
}

function detectBinary(buf: Buffer): boolean {
  // Simple heuristic: null byte indicates binary.
  return buf.includes(0);
}

function readTextFileSafe(absPath: string, maxBytes: number): { exists: boolean; text: string; isBinary?: boolean } {
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
      // If truncated, keep the visible prefix; UI can show a warning.
      return { exists: true, text };
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
): Promise<{ exists: boolean; text: string; isBinary?: boolean }> {
  const res = await runGit(["show", spec], { cwd, timeoutMs: 10_000 });
  if (res.exitCode !== 0) return { exists: false, text: "" };
  const buf = Buffer.from(res.stdout, "utf8");
  if (detectBinary(buf)) return { exists: true, text: "", isBinary: true };
  if (buf.length > maxBytes) return { exists: true, text: buf.subarray(0, maxBytes).toString("utf8") };
  return { exists: true, text: res.stdout };
}

export function createDiffService({ laneService }: { laneService: ReturnType<typeof createLaneService> }) {
  const MAX_TEXT_BYTES = 512 * 1024;

  return {
    async getChanges(laneId: string): Promise<DiffChanges> {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const res = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 12_000 });
      if (res.exitCode !== 0) {
        return { unstaged: [], staged: [] };
      }

      const unstaged: FileChange[] = [];
      const staged: FileChange[] = [];

      const lines = res.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("??")) {
          const p = stripGitStatusPath(line.slice(2));
          unstaged.push({ path: p, kind: "untracked" });
          continue;
        }
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        const p = stripGitStatusPath(line.slice(2));
        const code = `${x}${y}`;
        const kind = parseStatusKind(code);
        if (x !== " " && x !== "?") staged.push({ path: p, kind });
        if (y !== " " && y !== "?") unstaged.push({ path: p, kind });
      }

      return { unstaged, staged };
    },

    async getFileDiff({ laneId, filePath, mode }: { laneId: string; filePath: string; mode: DiffMode }): Promise<FileDiff> {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const abs = path.join(worktreePath, filePath);

      if (mode === "staged") {
        const head = await gitShowText(worktreePath, `HEAD:${filePath}`, MAX_TEXT_BYTES);
        const idx = await gitShowText(worktreePath, `:${filePath}`, MAX_TEXT_BYTES);
        const isBinary = Boolean(head.isBinary || idx.isBinary);
        return {
          path: filePath,
          mode,
          original: { exists: head.exists, text: head.text },
          modified: { exists: idx.exists, text: idx.text },
          ...(isBinary ? { isBinary: true } : {})
        };
      }

      // Unstaged: index -> working tree
      const idx = await gitShowText(worktreePath, `:${filePath}`, MAX_TEXT_BYTES);
      const wt = readTextFileSafe(abs, MAX_TEXT_BYTES);
      const isBinary = Boolean(idx.isBinary || wt.isBinary);
      return {
        path: filePath,
        mode,
        original: { exists: idx.exists, text: idx.text },
        modified: { exists: wt.exists, text: wt.text },
        ...(isBinary ? { isBinary: true } : {})
      };
    }
  };
}

