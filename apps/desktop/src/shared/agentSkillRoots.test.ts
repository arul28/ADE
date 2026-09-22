import { describe, expect, it } from "vitest";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  formatAdeAgentSkillRootsForPrompt,
  getAdeAgentSkillRootCandidates,
  getAgentSkillRootCandidates,
  getAdeAgentSkillRootsForPrompt,
  joinAdeAgentSkillRoots,
} from "./agentSkillRoots";

describe("agent skill roots", () => {
  it("lists project, user, inherited, and bundled skill roots for agent runtimes", () => {
    const roots = getAgentSkillRootCandidates({
      cwd: "/repo/.ade/worktrees/chat-lane",
      env: {
        HOME: "/home/agent",
        [ADE_AGENT_SKILLS_DIRS_ENV]: joinAdeAgentSkillRoots([
          "/repo/apps/desktop/resources/agent-skills",
        ]),
      },
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
    });

    expect(roots[0]).toBe("/repo/.ade/worktrees/chat-lane/.cursor/skills");
    expect(roots).toContain("/repo/.ade/worktrees/chat-lane/.claude/skills");
    expect(roots).toContain("/repo/.ade/worktrees/chat-lane/.agents/skills");
    expect(roots).toContain("/repo/.ade/worktrees/chat-lane/.ade/skills");
    expect(roots).toContain("/repo/.ade/worktrees/chat-lane/.codex/skills");
    expect(roots).toContain("/home/agent/.cursor/skills");
    expect(roots).toContain("/home/agent/.claude/skills");
    expect(roots).toContain("/home/agent/.agents/skills");
    expect(roots).toContain("/home/agent/.ade/skills");
    expect(roots).toContain("/home/agent/.codex/skills");
    expect(roots).toContain("/repo/.ade/worktrees/chat-lane/apps/desktop/resources/agent-skills");
    expect(roots).toContain("/repo/apps/desktop/resources/agent-skills");
    expect(roots).toContain("/Applications/ADE.app/Contents/Resources/agent-skills");
  });

  it("caps prompt-facing ADE skill roots while preserving runtime candidates", () => {
    const cwd = "/repo";
    const fromCwd = (...parts: string[]) => [cwd, ...parts].join("/");
    const options = {
      cwd,
      processCwd: null,
      env: {
        HOME: "/home/agent",
        [ADE_AGENT_SKILLS_DIRS_ENV]: joinAdeAgentSkillRoots([
          "/external/agent-skills-a",
          "/external/agent-skills-b",
          "/external/agent-skills-c",
        ]),
      },
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
    };

    const promptRoots = getAdeAgentSkillRootsForPrompt(options);
    const runtimeRoots = getAgentSkillRootCandidates(options);

    expect(promptRoots).toEqual([
      fromCwd("apps", "desktop", "resources", "agent-skills"),
      fromCwd("resources", "agent-skills"),
      "/external/agent-skills-a",
      "/external/agent-skills-b",
    ]);
    expect(promptRoots).toHaveLength(4);
    expect(runtimeRoots.length).toBeGreaterThan(promptRoots.length);
    expect(runtimeRoots).toContain("/home/agent/.codex/skills");
    expect(runtimeRoots).toContain("/external/agent-skills-c");
    expect(runtimeRoots).toContain("/Applications/ADE.app/Contents/Resources/agent-skills");
  });

  it("dedupes all skill root candidates and describes them generically", () => {
    const roots = getAgentSkillRootCandidates({
      cwd: "/repo",
      env: {
        HOME: "/home/agent",
        [ADE_AGENT_SKILLS_DIRS_ENV]: joinAdeAgentSkillRoots([
          "/repo/.agents/skills",
          "/repo/apps/desktop/resources/agent-skills",
        ]),
      },
    });

    expect(roots.filter((root) => root === "/repo/.agents/skills")).toHaveLength(1);
    const description = formatAdeAgentSkillRootsForPrompt(roots.slice(0, 2));
    expect(description).toContain("Agent skill roots for this session");
    expect(description).toContain("named skill");
  });

  it("never mints a bundled skill root from a filesystem root", () => {
    // A packaged app runs with `process.cwd() === "/"`. Joining onto it used to
    // advertise `/apps/desktop/resources/agent-skills` to every agent.
    const roots = getAdeAgentSkillRootCandidates({ cwd: "/", processCwd: "/", env: {}, dirname: null });

    expect(roots).not.toContain("/apps/desktop/resources/agent-skills");
    expect(roots).not.toContain("/resources/agent-skills");
    expect(roots).toEqual([]);
  });

  it("never doubles the apps/desktop segment when launched from apps/desktop", () => {
    const roots = getAdeAgentSkillRootCandidates({
      cwd: "/repo/apps/desktop",
      processCwd: null,
      env: {},
      dirname: null,
    });

    expect(roots).not.toContain("/repo/apps/desktop/apps/desktop/resources/agent-skills");
    expect(roots).toContain("/repo/apps/desktop/resources/agent-skills");
  });

  it("drops roots that are not on disk before applying the prompt cap", () => {
    const options = {
      cwd: "/repo",
      processCwd: null,
      env: {
        HOME: "/home/agent",
        [ADE_AGENT_SKILLS_DIRS_ENV]: joinAdeAgentSkillRoots([
          "/external/real-a",
          "/external/real-b",
        ]),
      },
      dirname: null,
    };
    const onDisk = new Set(["/external/real-a", "/external/real-b"]);

    const unfiltered = getAdeAgentSkillRootsForPrompt(options);
    const filtered = getAdeAgentSkillRootsForPrompt({
      ...options,
      exists: (candidate) => onDisk.has(candidate),
    });

    // Without the filter the two repo-relative shapes eat two of the four slots
    // even though neither exists, and the agent is told to read them.
    expect(unfiltered).toContain("/repo/apps/desktop/resources/agent-skills");
    expect(filtered).toEqual(["/external/real-a", "/external/real-b"]);
  });

  it("describes the env var when no advertised root survives the disk check", () => {
    const filtered = getAdeAgentSkillRootsForPrompt({
      cwd: "/repo",
      processCwd: null,
      env: {},
      dirname: null,
      exists: () => false,
    });

    expect(filtered).toEqual([]);
    expect(formatAdeAgentSkillRootsForPrompt(filtered)).toContain("ADE_AGENT_SKILLS_DIRS");
  });
});
