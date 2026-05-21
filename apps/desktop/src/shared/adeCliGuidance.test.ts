import { describe, expect, it } from "vitest";
import { ADE_BUNDLED_AGENT_SKILLS, buildAdeCliAgentGuidance } from "./adeCliGuidance";

describe("ADE CLI guidance", () => {
  it("preinjects bundled skill discovery guidance for every ADE runtime surface", () => {
    const guidance = buildAdeCliAgentGuidance(["/Applications/ADE.app/Contents/Resources/agent-skills"]);

    expect(guidance).toContain("### Skills");
    expect(guidance).toContain("project, user, runtime, and bundled ADE skill roots");
    expect(guidance).toContain("ADE-hosted Work chats");
    expect(guidance).toContain("ADE Code/TUI sessions");
    expect(guidance).toContain("CTO and mission worker prompts");
    expect(guidance).toContain("mobile-started work");
    expect(guidance).toContain("ADE_AGENT_SKILLS_DIRS");
    expect(guidance).toContain("<skill-name>/SKILL.md");
    expect(guidance).toContain("references/");
    for (const skillName of ADE_BUNDLED_AGENT_SKILLS) {
      expect(guidance).toContain(`\`${skillName}\``);
    }
  });
});
