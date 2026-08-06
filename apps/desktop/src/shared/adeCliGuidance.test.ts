import { MAX_STATUS_NOTE_CHARACTERS, STATUS_NOTE_GUIDELINE_WORDS } from "./sessionStatusNote";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
    expect(bootstrap).toContain("ade skill list --text");
    expect(bootstrap).toContain("ade skill show <name> --text");
    expect(bootstrap).toContain("ade chat scheduled-work create");
    expect(bootstrap).toContain("tracked provider CLIs");
    expect(bootstrap).toContain('ade chat note "testing desktop auth fallback"');
    expect(bootstrap).toContain("6 words or fewer");
    expect(bootstrap).toContain(`${MAX_STATUS_NOTE_CHARACTERS} characters`);
    expect(bootstrap).toContain('ade chat ask "<the exact question>"');
    expect(bootstrap).toContain("a note alone can leave an idle row looking Done");
    expect(bootstrap).toContain("The next accepted user message clears the prior hand-raise");
    // Settlement is user- and PR-merge-driven only: the bootstrap must tell the
    // agent it CANNOT settle, and must never hand it a settle command again.
    expect(bootstrap).toContain("You cannot settle or unsettle a session");
    expect(bootstrap).toContain("the user's call, or the automatic result of its PR merging");
    expect(bootstrap).not.toContain("ade chat settle --outcome");
    expect(bootstrap).toContain("ade session snooze <id> --for <duration>");
    // The skill index is still advertised so the model knows what exists.
    for (const skillName of adeBundledAgentSkills) {
      expect(bootstrap).toContain(`\`${skillName}\``);
    }
  });

  it("stays within a small budget — the always-on socket/browser/proof tax is gone", () => {
    const bootstrap = buildAdeBootstrapGuidance(roots);

    // The redesign dropped the ~4,300-char blob; the bootstrap must stay tiny
    // Keep the shared lifecycle protocol compact while guarding against
    // regrowth into the old per-domain rulebook.
    expect(bootstrap.length).toBeLessThan(2600);
    // The per-domain operating rules now live in their skills, not always-on.
    expect(bootstrap).not.toContain("### Minimum operating rules");
    expect(bootstrap).not.toContain("--socket");
  });

  it("keeps the bundled control-plane skill aligned with the bootstrap lifecycle contract", () => {
    const bootstrap = buildAdeBootstrapGuidance(roots);
    const skill = fs.readFileSync(fileURLToPath(new URL(
      "../../resources/agent-skills/ade-cli-control-plane/SKILL.md",
      import.meta.url,
    )), "utf8");

    for (const invariant of [
      "ade chat note",
      "ade chat ask",
      "You cannot settle or unsettle a session",
    ]) {
      expect(bootstrap.toLowerCase()).toContain(invariant.toLowerCase());
      expect(skill.toLowerCase()).toContain(invariant.toLowerCase());
    }
    expect(bootstrap).toContain("next accepted user message clears the prior hand-raise");
    expect(skill).toContain("next accepted user message clears the hand-raise");
    // The skill deliberately points at the code-owned bounds instead of
    // duplicating values that can drift from the runtime contract.
    expect(skill).toContain("sessionStatusNote.ts");
    expect(bootstrap).toContain(`${STATUS_NOTE_GUIDELINE_WORDS} words or fewer`);
    expect(bootstrap).toContain(`${MAX_STATUS_NOTE_CHARACTERS} characters`);
  });
});
