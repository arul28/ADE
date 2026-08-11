import { MAX_STATUS_NOTE_CHARACTERS, STATUS_NOTE_GUIDELINE_WORDS } from "./sessionStatusNote";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adeBundledAgentSkills,
  advertisedAdeAgentSkills,
  buildAdeBootstrapGuidance,
  buildAdeCliAgentGuidance,
} from "./adeCliGuidance";
import type { PluginBuiltinSurfaceId } from "./plugins/manifest";

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

/**
 * The roster is an ADVERTISEMENT, and only the advertisement is gated. Nothing
 * here should ever assert that a skill stops loading or that an action stops
 * running — those stay available on every machine, installed plugin or not.
 */
describe("advertised skill roster", () => {
  const roots = ["/Applications/ADE.app/Contents/Resources/agent-skills"];
  const surfaces = (...ids: PluginBuiltinSurfaceId[]) => new Set<PluginBuiltinSurfaceId>(ids);

  it("names every bundled skill when the caller cannot know what is installed", () => {
    expect(advertisedAdeAgentSkills()).toEqual(adeBundledAgentSkills);
    expect(advertisedAdeAgentSkills({ installedBuiltinSurfaces: null })).toEqual(adeBundledAgentSkills);
  });

  it("drops the surface-owning skills on a machine with no plugins", () => {
    const advertised = advertisedAdeAgentSkills({ installedBuiltinSurfaces: surfaces() });

    expect(advertised).not.toContain("ade-ios-simulator");
    expect(advertised).not.toContain("ade-app-control");
    expect(advertised).not.toContain("ade-linear");
    // Everything that is not a plugin-owned surface survives untouched.
    expect(advertised).toContain("ade-cli-control-plane");
    expect(advertised).toContain("ade-browser");
    expect(advertised).toContain("ade-plugins");
  });

  it("names each skill exactly when its owning surface is installed", () => {
    const advertised = advertisedAdeAgentSkills({ installedBuiltinSurfaces: surfaces("linear", "ios") });

    expect(advertised).toContain("ade-linear");
    expect(advertised).toContain("ade-ios-simulator");
    expect(advertised).not.toContain("ade-app-control");
  });

  it("carries the trim into the bootstrap text the agent actually reads", () => {
    const withNone = buildAdeBootstrapGuidance(roots, { installedBuiltinSurfaces: surfaces() });
    const withAppControl = buildAdeBootstrapGuidance(roots, {
      installedBuiltinSurfaces: surfaces("app-control"),
    });

    expect(withNone).not.toContain("`ade-app-control`");
    expect(withNone).not.toContain("`ade-linear`");
    expect(withAppControl).toContain("`ade-app-control`");
    expect(withAppControl).not.toContain("`ade-linear`");
    // The fallback that makes every skill reachable regardless is still there,
    // which is what keeps this a trimmed advertisement and not a capability cut.
    expect(withNone).toContain("ade skill show <name> --text");
  });
});
