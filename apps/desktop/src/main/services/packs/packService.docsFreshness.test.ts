import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openKvDb } from "../state/kvDb";
import { createPackService } from "./packService";

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? "").trim();
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function readContextFingerprint(body: string): string {
  const line = body
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("Context fingerprint:"));
  const value = (line ?? "").split(":").slice(1).join(":").trim();
  if (!value) throw new Error("Context fingerprint line missing");
  return value;
}

describe("packService docs freshness", () => {
  it("refreshes project context fingerprint when docs change", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pack-docs-"));
    const packsDir = path.join(projectRoot, ".ade", "packs");
    fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "docs", "features"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n\nInitial\n", "utf8");
    fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "SYSTEM.md"), "# System\n\nv1\n", "utf8");
    fs.writeFileSync(path.join(projectRoot, "docs", "features", "CONFLICTS.md"), "# Conflicts\n\nv1\n", "utf8");
    git(projectRoot, ["init", "-b", "main"]);
    git(projectRoot, ["config", "user.email", "ade@test.local"]);
    git(projectRoot, ["config", "user.name", "ADE Test"]);
    git(projectRoot, ["add", "."]);
    git(projectRoot, ["commit", "-m", "init docs"]);

    const db = await openKvDb(path.join(projectRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-docs";
    const now = "2026-02-15T19:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, projectRoot, "demo", "main", now, now]
    );

    const packService = createPackService({
      db,
      logger: createLogger(),
      projectRoot,
      projectId,
      packsDir,
      laneService: {
        list: async () => [],
        getLaneBaseAndBranch: () => ({ worktreePath: projectRoot, baseRef: "main", branchRef: "main" })
      } as any,
      sessionService: { readTranscriptTail: () => "" } as any,
      projectConfigService: {
        get: () => ({
          local: { providers: {} },
          effective: {
            providerMode: "guest",
            providers: {},
            processes: [],
            testSuites: [],
            stackButtons: []
          }
        })
      } as any,
      operationService: { start: () => ({ operationId: "op-1" }), finish: () => {} } as any
    });

    const first = await packService.refreshProjectPack({ reason: "onboarding_init" });
    const firstFingerprint = readContextFingerprint(first.body);

    fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "SYSTEM.md"), "# System\n\nv2 changed\n", "utf8");

    const second = await packService.refreshProjectPack({ reason: "docs_churn" });
    const secondFingerprint = readContextFingerprint(second.body);

    expect(secondFingerprint).not.toBe(firstFingerprint);

    const exportLite = await packService.getProjectExport({ level: "lite" });
    expect(exportLite.content).toContain(secondFingerprint);
    expect(exportLite.content).toContain("\"contextVersion\"");
    expect(exportLite.content).toContain("\"lastDocsRefreshAt\"");
  });
});
