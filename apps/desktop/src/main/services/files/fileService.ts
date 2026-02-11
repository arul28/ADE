import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { createLaneService } from "../lanes/laneService";

function isWithinDir(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function containsDotGit(absPath: string): boolean {
  const parts = absPath.split(path.sep);
  return parts.includes(".git");
}

export function createFileService({ laneService }: { laneService: ReturnType<typeof createLaneService> }) {
  return {
    writeTextAtomic({ laneId, relPath, text }: { laneId: string; relPath: string; text: string }): void {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const abs = path.normalize(path.join(worktreePath, relPath));
      if (!isWithinDir(worktreePath, abs)) {
        throw new Error("Refusing to write outside lane worktree");
      }
      if (containsDotGit(abs)) {
        throw new Error("Refusing to write into .git");
      }

      fs.mkdirSync(path.dirname(abs), { recursive: true });

      const tmp = `${abs}.tmp-${randomUUID()}`;
      fs.writeFileSync(tmp, text, "utf8");

      try {
        fs.renameSync(tmp, abs);
      } catch (err: any) {
        // Windows may fail to rename over an existing file; fallback (best-effort).
        try {
          fs.copyFileSync(tmp, abs);
          fs.unlinkSync(tmp);
        } catch {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // ignore
          }
          throw err;
        }
      }
    }
  };
}

