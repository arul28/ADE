import { describe, expect, it } from "vitest";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  getAdeAgentSkillRootsForPrompt,
  joinAdeAgentSkillRoots,
} from "./agentSkillRoots";

describe("agent skill roots", () => {
  it("prefers the active lane worktree skill root before inherited app roots", () => {
    const roots = getAdeAgentSkillRootsForPrompt({
      cwd: "/repo/.ade/worktrees/chat-lane",
      env: {
        [ADE_AGENT_SKILLS_DIRS_ENV]: joinAdeAgentSkillRoots([
          "/repo/apps/desktop/resources/agent-skills",
        ]),
      },
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
    });

    expect(roots[0]).toBe("/repo/.ade/worktrees/chat-lane/apps/desktop/resources/agent-skills");
    expect(roots).toContain("/repo/apps/desktop/resources/agent-skills");
    expect(roots).toContain("/Applications/ADE.app/Contents/Resources/agent-skills");
  });
});
