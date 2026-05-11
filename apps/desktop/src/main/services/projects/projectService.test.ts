import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openKvDb } from "../state/kvDb";
import { resolveRepoRoot, upsertProjectRow } from "./projectService";

const tempRoots = new Set<string>();

function makeTempRoot(prefix = "ade-project-service-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("resolveRepoRoot", () => {
  it("normalizes an ADE-managed lane worktree back to the parent project", async () => {
    const rawProjectRoot = makeTempRoot("ade-project-service-worktree-");
    fs.mkdirSync(path.join(rawProjectRoot, ".ade"), { recursive: true });
    const projectRoot = fs.realpathSync.native(rawProjectRoot);
    const nested = path.join(projectRoot, ".ade", "worktrees", "feature-a", "apps", "desktop");
    fs.mkdirSync(nested, { recursive: true });

    await expect(resolveRepoRoot(nested)).resolves.toBe(projectRoot);
  });
});

describe("upsertProjectRow", () => {
  it("repairs an existing project row recorded against an ADE-managed lane worktree", async () => {
    const rawProjectRoot = makeTempRoot("ade-project-service-upsert-");
    fs.mkdirSync(path.join(rawProjectRoot, ".ade"), { recursive: true });
    const projectRoot = fs.realpathSync.native(rawProjectRoot);
    const worktreeRoot = path.join(projectRoot, ".ade", "worktrees", "feature-a");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger());
    try {
      const now = "2026-05-11T00:00:00.000Z";
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["project-worktree", worktreeRoot, "Feature A", "main", now, now],
      );

      const result = upsertProjectRow({
        db,
        repoRoot: projectRoot,
        displayName: "ADE",
        baseRef: "main",
      });

      expect(result.projectId).toBe("project-worktree");
      expect(db.all("select id, root_path from projects")).toEqual([
        { id: "project-worktree", root_path: projectRoot },
      ]);
    } finally {
      db.close();
    }
  });
});
