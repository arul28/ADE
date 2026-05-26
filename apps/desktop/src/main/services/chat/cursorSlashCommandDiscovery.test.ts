import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverCursorSlashCommands,
  resolveCursorSlashCommandInvocation,
} from "./cursorSlashCommandDiscovery";

let tmpRoot = "";

describe("cursorSlashCommandDiscovery", () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-slash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("discovers Cursor command files, subagents, built-in subagents, and skills", () => {
    const commandDir = path.join(tmpRoot, ".cursor", "commands");
    const agentsDir = path.join(tmpRoot, ".cursor", "agents");
    const skillsDir = path.join(tmpRoot, ".cursor", "skills", "release-auditor");
    fs.mkdirSync(commandDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, "review-code.md"), [
      "---",
      "description: Review the active diff",
      "argument-hint: [scope]",
      "---",
      "",
      "Review $ARGUMENTS.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(agentsDir, "security-reviewer.md"), [
      "---",
      "name: security-reviewer",
      "description: Review code for common security issues",
      "model: inherit",
      "---",
      "",
      "Check the target.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(skillsDir, "SKILL.md"), [
      "---",
      "name: release-auditor",
      "description: Audit release readiness",
      "---",
      "",
      "Audit release state.",
      "",
    ].join("\n"));

    const commands = discoverCursorSlashCommands(tmpRoot);

    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "/review-code",
        description: "Review the active diff",
        argumentHint: "[scope]",
        source: "command",
      }),
      expect.objectContaining({
        name: "/security-reviewer",
        description: "Review code for common security issues",
        source: "subagent",
      }),
      expect.objectContaining({
        name: "/release-auditor",
        description: "Audit release readiness",
        source: "skill",
      }),
      expect.objectContaining({
        name: "/explore",
        source: "subagent",
      }),
    ]));
  });

  it("expands Cursor command files and leaves subagent slash names native", () => {
    const commandDir = path.join(tmpRoot, ".cursor", "commands");
    const agentsDir = path.join(tmpRoot, ".cursor", "agents");
    fs.mkdirSync(commandDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, "write-tests.md"), [
      "---",
      "description: Write tests",
      "---",
      "",
      "Write tests for $ARGUMENTS.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(agentsDir, "verifier.md"), [
      "---",
      "description: Verify the implementation",
      "---",
      "",
      "Verify work.",
      "",
    ].join("\n"));

    expect(resolveCursorSlashCommandInvocation(tmpRoot, "/write-tests auth flow")).toEqual({
      name: "/write-tests",
      argumentsText: "auth flow",
      promptText: "Write tests for auth flow.",
    });
    expect(resolveCursorSlashCommandInvocation(tmpRoot, "/verifier check this")).toBeNull();
  });

  it("always includes built-in subagents even when no .cursor directory exists", () => {
    const commands = discoverCursorSlashCommands(tmpRoot);
    const names = commands.map((c) => c.name);

    expect(names).toContain("/explore");
    expect(names).toContain("/bash");
    expect(names).toContain("/browser");
    expect(commands.filter((c) => c.source === "subagent")).toHaveLength(3);
  });

  it("returns null for unknown slash commands", () => {
    expect(resolveCursorSlashCommandInvocation(tmpRoot, "/nonexistent do stuff")).toBeNull();
    expect(resolveCursorSlashCommandInvocation(tmpRoot, "not a slash command")).toBeNull();
  });
});
