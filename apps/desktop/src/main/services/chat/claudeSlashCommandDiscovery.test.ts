import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverClaudeSlashCommands } from "./claudeSlashCommandDiscovery";

let tmpRoot: string;
let homeRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-commands-test-"));
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-home-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

describe("discoverClaudeSlashCommands", () => {
  it("discovers project command files with frontmatter metadata", () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "automate.md"), [
      "---",
      "description: Generate comprehensive test suites",
      "argument-hint: [area]",
      "---",
      "",
      "Run tests for $ARGUMENTS.",
      "",
    ].join("\n"));

    expect(discoverClaudeSlashCommands(tmpRoot)).toEqual([
      {
        name: "/automate",
        description: "Generate comprehensive test suites",
        argumentHint: "[area]",
      },
    ]);
  });

  it("namespaces nested project command files like Claude Code", () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands", "frontend");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "test.md"), [
      "---",
      "description: Run frontend tests",
      "---",
      "",
      "Test the frontend.",
      "",
    ].join("\n"));

    expect(discoverClaudeSlashCommands(tmpRoot)).toEqual([
      {
        name: "/frontend:test",
        description: "Run frontend tests",
      },
    ]);
  });

  it("discovers invocable skills and hides non-user-invocable skills", () => {
    const visibleSkill = path.join(tmpRoot, ".claude", "skills", "fix-issue");
    const hiddenSkill = path.join(tmpRoot, ".claude", "skills", "background-context");
    fs.mkdirSync(visibleSkill, { recursive: true });
    fs.mkdirSync(hiddenSkill, { recursive: true });
    fs.writeFileSync(path.join(visibleSkill, "SKILL.md"), [
      "---",
      "name: fix-issue",
      "description: Fix a GitHub issue",
      "---",
      "",
      "Fix $ARGUMENTS.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(hiddenSkill, "SKILL.md"), [
      "---",
      "name: background-context",
      "description: Hidden context",
      "user-invocable: false",
      "---",
      "",
      "Do not show this.",
      "",
    ].join("\n"));

    expect(discoverClaudeSlashCommands(tmpRoot)).toEqual([
      {
        name: "/fix-issue",
        description: "Fix a GitHub issue",
      },
    ]);
  });

  it("includes personal commands and lets project commands with the same name win", () => {
    fs.mkdirSync(path.join(homeRoot, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, ".claude", "commands", "ship.md"), [
      "---",
      "description: Personal ship",
      "---",
      "",
      "Ship it.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpRoot, ".claude", "commands", "ship.md"), [
      "---",
      "description: Project ship",
      "---",
      "",
      "Ship this project.",
      "",
    ].join("\n"));

    expect(discoverClaudeSlashCommands(tmpRoot)).toEqual([
      {
        name: "/ship",
        description: "Project ship",
      },
    ]);
  });
});
