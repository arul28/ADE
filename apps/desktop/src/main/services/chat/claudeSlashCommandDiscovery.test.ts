import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverClaudeSlashCommands, resolveClaudeSlashCommandInvocation } from "./claudeSlashCommandDiscovery";

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

    expect(discoverClaudeSlashCommands(tmpRoot)).toMatchObject([
      {
        name: "/automate",
        description: "Generate comprehensive test suites",
        argumentHint: "[area]",
      },
    ]);
  });

  it("uses nested project command paths for unambiguous discovery", () => {
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

    expect(discoverClaudeSlashCommands(tmpRoot)).toMatchObject([
      {
        name: "/frontend:test",
        description: "Run frontend tests",
      },
    ]);
  });

  it("skips legacy command directories deeper than the traversal cap", () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    const visibleDir = path.join(commandsDir, ...Array.from({ length: 10 }, (_, index) => `level-${index}`));
    const skippedDir = path.join(visibleDir, "too-deep");
    fs.mkdirSync(skippedDir, { recursive: true });
    fs.writeFileSync(path.join(visibleDir, "visible.md"), [
      "---",
      "description: Visible nested command",
      "---",
      "",
      "Visible.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(skippedDir, "hidden.md"), [
      "---",
      "description: Hidden nested command",
      "---",
      "",
      "Hidden.",
      "",
    ].join("\n"));

    expect(discoverClaudeSlashCommands(tmpRoot)).toMatchObject([
      {
        name: "/level-0:level-1:level-2:level-3:level-4:level-5:level-6:level-7:level-8:level-9:visible",
        description: "Visible nested command",
      },
    ]);
  });

  it("preserves command filename casing and dedupes case variants by project precedence", () => {
    fs.mkdirSync(path.join(homeRoot, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, ".claude", "commands", "shipLane.md"), [
      "---",
      "description: Personal ship lane",
      "---",
      "",
      "Personal.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpRoot, ".claude", "commands", "shipLane.md"), [
      "---",
      "description: Project ship lane",
      "---",
      "",
      "Project.",
      "",
    ].join("\n"));

    const commands = discoverClaudeSlashCommands(tmpRoot);
    expect(commands.filter((command) => command.name.toLowerCase() === "/shiplane")).toHaveLength(1);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "/shipLane",
        description: "Project ship lane",
      }),
    ]));
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

    const commands = discoverClaudeSlashCommands(tmpRoot);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "/fix-issue",
        description: "Fix a GitHub issue",
      }),
    ]));
    expect(commands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/background-context" }),
    ]));
  });

  it("discovers cross-client .agents skills and ADE project skills", () => {
    const agentsSkill = path.join(tmpRoot, ".agents", "skills", "ios-lab");
    const adeSkill = path.join(tmpRoot, ".ade", "skills", "pr-resolver");
    fs.mkdirSync(agentsSkill, { recursive: true });
    fs.mkdirSync(adeSkill, { recursive: true });
    fs.writeFileSync(path.join(agentsSkill, "SKILL.md"), [
      "---",
      "name: ios-lab",
      "description: Use this skill for simulator work",
      "---",
      "",
      "Inspect the simulator.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(adeSkill, "SKILL.md"), [
      "---",
      "name: pr-resolver",
      "description: Use this skill for PR resolver work",
      "---",
      "",
      "Resolve the PR.",
      "",
    ].join("\n"));

    const commands = discoverClaudeSlashCommands(tmpRoot);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "/ios-lab",
        description: "Use this skill for simulator work",
        source: "skill",
      }),
      expect.objectContaining({
        name: "/pr-resolver",
        description: "Use this skill for PR resolver work",
        source: "skill",
      }),
    ]));
  });

  it("walks up parent directories to discover .claude/commands at workspace root from a lane subdir", () => {
    const workspaceCommands = path.join(tmpRoot, ".claude", "commands");
    fs.mkdirSync(workspaceCommands, { recursive: true });
    fs.writeFileSync(path.join(workspaceCommands, "audit.md"), [
      "---",
      "description: Workspace-root audit",
      "---",
      "",
      "Audit.",
      "",
    ].join("\n"));
    const laneWorktree = path.join(tmpRoot, "lanes", "feature-x", "worktree");
    fs.mkdirSync(laneWorktree, { recursive: true });

    expect(discoverClaudeSlashCommands(laneWorktree)).toMatchObject([
      {
        name: "/audit",
        description: "Workspace-root audit",
        source: "command",
      },
    ]);
  });

  it("walks up parent directories for resolveClaudeSlashCommandInvocation as well", () => {
    const workspaceCommands = path.join(tmpRoot, ".claude", "commands");
    fs.mkdirSync(workspaceCommands, { recursive: true });
    fs.writeFileSync(path.join(workspaceCommands, "audit.md"), [
      "---",
      "description: Workspace-root audit",
      "---",
      "",
      "Audit $ARGUMENTS.",
      "",
    ].join("\n"));
    const laneWorktree = path.join(tmpRoot, "lanes", "feature-y", "worktree");
    fs.mkdirSync(laneWorktree, { recursive: true });

    expect(resolveClaudeSlashCommandInvocation(laneWorktree, "/audit the model pane")?.promptText)
      .toBe("Audit the model pane.");
  });

  it("resolves nested commands by basename and keeps legacy colon names working", () => {
    const nestedCommands = path.join(tmpRoot, ".claude", "commands", "frontend");
    fs.mkdirSync(nestedCommands, { recursive: true });
    fs.writeFileSync(path.join(nestedCommands, "component.md"), "Build component $ARGUMENTS.\n");

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/component button")?.promptText)
      .toBe("Build component button.");
    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/frontend:component button")?.promptText)
      .toBe("Build component button.");
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

    expect(discoverClaudeSlashCommands(tmpRoot)).toMatchObject([
      {
        name: "/ship",
        description: "Project ship",
      },
    ]);
  });

  it("does not let home commands override project commands when the project is under home", () => {
    const projectRoot = path.join(homeRoot, "workspace", "project");
    fs.mkdirSync(path.join(homeRoot, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, ".claude", "commands", "audit.md"), "Personal audit.\n");
    fs.writeFileSync(path.join(projectRoot, ".claude", "commands", "audit.md"), "Project audit.\n");

    expect(discoverClaudeSlashCommands(projectRoot)).toMatchObject([
      {
        name: "/audit",
        description: "Project audit.",
      },
    ]);
  });

  it("keeps nested commands with the same basename distinct", () => {
    const frontendCommands = path.join(tmpRoot, ".claude", "commands", "frontend");
    const backendCommands = path.join(tmpRoot, ".claude", "commands", "backend");
    fs.mkdirSync(frontendCommands, { recursive: true });
    fs.mkdirSync(backendCommands, { recursive: true });
    fs.writeFileSync(path.join(frontendCommands, "button.md"), "Frontend button.\n");
    fs.writeFileSync(path.join(backendCommands, "button.md"), "Backend button.\n");

    expect(discoverClaudeSlashCommands(tmpRoot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/backend:button", description: "Backend button." }),
      expect.objectContaining({ name: "/frontend:button", description: "Frontend button." }),
    ]));
  });
});

describe("resolveClaudeSlashCommandInvocation", () => {
  it("expands project command files with $ARGUMENTS before sending to Claude", () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "audit.md"), [
      "---",
      "description: Audit recent work",
      "---",
      "",
      "Audit the work you just did.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/audit chat command menu")).toEqual({
      name: "/audit",
      argumentsText: "chat command menu",
      promptText: "Audit the work you just did.\n\nFocus: chat command menu",
    });
  });

  it("lets project command files override same-named personal command files", () => {
    fs.mkdirSync(path.join(homeRoot, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, ".claude", "commands", "ship.md"), "Personal $ARGUMENTS\n");
    fs.writeFileSync(path.join(tmpRoot, ".claude", "commands", "ship.md"), "Project $ARGUMENTS\n");

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/ship now")?.promptText).toBe("Project now");
  });

  it("lets project command files under home override same-named personal command files", () => {
    const projectRoot = path.join(homeRoot, "workspace", "project");
    fs.mkdirSync(path.join(homeRoot, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, ".claude", "commands", "ship.md"), "Personal $ARGUMENTS\n");
    fs.writeFileSync(path.join(projectRoot, ".claude", "commands", "ship.md"), "Project $ARGUMENTS\n");

    expect(resolveClaudeSlashCommandInvocation(projectRoot, "/ship now")?.promptText).toBe("Project now");
  });

  it("requires colon paths when nested command basenames are ambiguous", () => {
    const frontendCommands = path.join(tmpRoot, ".claude", "commands", "frontend");
    const backendCommands = path.join(tmpRoot, ".claude", "commands", "backend");
    fs.mkdirSync(frontendCommands, { recursive: true });
    fs.mkdirSync(backendCommands, { recursive: true });
    fs.writeFileSync(path.join(frontendCommands, "button.md"), "Frontend $ARGUMENTS\n");
    fs.writeFileSync(path.join(backendCommands, "button.md"), "Backend $ARGUMENTS\n");

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/button primary")).toBeNull();
    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/frontend:button primary")?.promptText)
      .toBe("Frontend primary");
    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/backend:button primary")?.promptText)
      .toBe("Backend primary");
  });

  it("returns null for built-in commands and unknown command files", () => {
    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/help")).toBeNull();
    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/missing")).toBeNull();
  });

  it("falls back to a skill SKILL.md when no command file matches", () => {
    const skillDir = path.join(tmpRoot, ".claude", "skills", "audit");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: audit",
      "description: Audit recent work",
      "---",
      "",
      "Audit the work for $ARGUMENTS.",
      "",
    ].join("\n"));

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/audit slash menu")?.promptText)
      .toBe("Audit the work for slash menu.");
  });

  it("prefers a command file over a same-named skill", () => {
    const cmdDir = path.join(tmpRoot, ".claude", "commands");
    const skillDir = path.join(tmpRoot, ".claude", "skills", "ship");
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, "ship.md"), "Command body $ARGUMENTS\n");
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: ship",
      "description: Ship",
      "---",
      "",
      "Skill body $ARGUMENTS",
      "",
    ].join("\n"));

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/ship now")?.promptText)
      .toBe("Command body now");
  });

  it("walks up ancestors to resolve a skill at workspace root from a lane subdir", () => {
    const skillDir = path.join(tmpRoot, ".claude", "skills", "audit");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: audit",
      "description: Audit",
      "---",
      "",
      "Run audit on $ARGUMENTS.",
      "",
    ].join("\n"));
    const lane = path.join(tmpRoot, "lanes", "feat", "wt");
    fs.mkdirSync(lane, { recursive: true });

    expect(resolveClaudeSlashCommandInvocation(lane, "/audit X")?.promptText)
      .toBe("Run audit on X.");
  });

  it("ignores skills marked user-invocable: false", () => {
    const skillDir = path.join(tmpRoot, ".claude", "skills", "internal");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: internal",
      "description: Internal",
      "user-invocable: false",
      "---",
      "",
      "Hidden body.",
      "",
    ].join("\n"));

    expect(resolveClaudeSlashCommandInvocation(tmpRoot, "/internal")).toBeNull();
  });
});
