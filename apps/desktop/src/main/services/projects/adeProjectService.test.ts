import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdeGitignore, resolveAdeLayout } from "../../../shared/adeLayout";
import { initializeOrRepairAdeProject } from "./adeProjectService";

function createRepoFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-layout-"));
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n/.ade\n", "utf8");
  fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "*.tmp\n.ade/\n", "utf8");

  fs.mkdirSync(path.join(root, ".ade", "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ade", "logs", "main.jsonl"), "{\"ok\":true}\n", "utf8");
  fs.mkdirSync(path.join(root, ".ade", "chat-sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ade", "chat-sessions", "session-1.json"), "{\"id\":\"session-1\"}\n", "utf8");
  fs.writeFileSync(path.join(root, ".ade", "mission-state-run-1.json"), "{\"runId\":\"run-1\"}\n", "utf8");

  return root;
}

describe("initializeOrRepairAdeProject", () => {
  it("creates the canonical layout, scrubs stale git excludes, and rehomes legacy state", () => {
    const root = createRepoFixture();
    const layout = resolveAdeLayout(root);

    const result = initializeOrRepairAdeProject(root);

    expect(result.cleanup.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).not.toContain("/.ade");
    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).not.toContain(".ade/");
    const adeGitignore = fs.readFileSync(path.join(layout.adeDir, ".gitignore"), "utf8");
    expect(adeGitignore).toBe(buildAdeGitignore());
    expect(adeGitignore).toContain("cto/core-memory.json");
    expect(adeGitignore).toContain("context/");
    expect(adeGitignore).toContain("agents/");
    expect(adeGitignore).not.toContain("cto/identity.yaml");
    expect(fs.readFileSync(path.join(layout.adeDir, "ade.yaml"), "utf8")).toContain("version: 1");
    expect(fs.readFileSync(path.join(layout.ctoDir, "identity.yaml"), "utf8")).toContain("name: CTO");
    expect(fs.existsSync(path.join(layout.templatesDir, ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(layout.skillsDir, ".gitkeep"))).toBe(true);
    expect(fs.existsSync(layout.linearWorkflowsDir)).toBe(true);
    expect(fs.existsSync(path.join(layout.logsDir, "main.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(layout.chatSessionsDir, "session-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(layout.missionStateDir, "mission-state-run-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(layout.adeDir, "logs"))).toBe(false);
    expect(fs.existsSync(path.join(layout.adeDir, "chat-sessions"))).toBe(false);
  });

  it("is idempotent once the canonical structure is in place", () => {
    const root = createRepoFixture();

    initializeOrRepairAdeProject(root);
    const second = initializeOrRepairAdeProject(root);

    expect(second.cleanup.changed).toBe(false);
    expect(second.cleanup.actions).toHaveLength(0);
  });

  it("does not overwrite an existing shared ade.yaml", () => {
    const root = createRepoFixture();
    const layout = resolveAdeLayout(root);
    fs.mkdirSync(layout.adeDir, { recursive: true });
    fs.writeFileSync(path.join(layout.adeDir, "ade.yaml"), "version: 1\nprocesses:\n  - id: keep-me\n", "utf8");

    initializeOrRepairAdeProject(root);

    expect(fs.readFileSync(path.join(layout.adeDir, "ade.yaml"), "utf8")).toContain("keep-me");
  });
});
