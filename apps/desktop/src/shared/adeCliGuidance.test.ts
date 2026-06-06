import { describe, expect, it } from "vitest";
import { adeBundledAgentSkills, buildAdeBootstrapGuidance, buildAdeCliAgentGuidance } from "./adeCliGuidance";

describe("ADE CLI guidance", () => {
  it("now aliases the minimal bootstrap (the verbose always-on blob was removed)", () => {
    const roots = ["/Applications/ADE.app/Contents/Resources/agent-skills"];
    const guidance = buildAdeCliAgentGuidance(roots);

    // The canonical builder is a thin alias over the bootstrap.
    expect(guidance).toBe(buildAdeBootstrapGuidance(roots));
    // It still advertises the bundled skill index so the model knows what exists.
    for (const skillName of adeBundledAgentSkills) {
      expect(guidance).toContain(`\`${skillName}\``);
    }
    // The old always-on rulebook is gone — those rules now live in the skills.
    expect(guidance).not.toContain("### Minimum operating rules");
  });
});

describe("ADE bootstrap guidance", () => {
  const roots = ["/Applications/ADE.app/Contents/Resources/agent-skills"];

  it("teaches the skill-on-demand habit and the ground-truth CLI fallback", () => {
    const bootstrap = buildAdeBootstrapGuidance(roots);

    expect(bootstrap).toContain("## ADE");
    // The habit: reach for the matching skill on demand, not an inlined rulebook.
    expect(bootstrap).toContain("read the matching `ade-*` skill");
    // The fallback: CLI help is ground truth (agents are not trained on `ade`).
    expect(bootstrap).toContain("ade help <command>");
    expect(bootstrap).toContain("ade actions list --text");
    // The skill index is still advertised so the model knows what exists.
    for (const skillName of adeBundledAgentSkills) {
      expect(bootstrap).toContain(`\`${skillName}\``);
    }
  });

  it("stays within a small budget — the always-on socket/browser/proof tax is gone", () => {
    const bootstrap = buildAdeBootstrapGuidance(roots);

    // The redesign dropped the ~4,300-char blob; the bootstrap must stay tiny
    // (~260 tokens). Guard against silent re-growth back into a rulebook.
    expect(bootstrap.length).toBeLessThan(1600);
    // The per-domain operating rules now live in their skills, not always-on.
    expect(bootstrap).not.toContain("### Minimum operating rules");
    expect(bootstrap).not.toContain("--socket");
  });
});
