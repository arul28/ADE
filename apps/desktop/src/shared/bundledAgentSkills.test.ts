// ADE's bundled agent skills were enumerated in three places that disagreed.
//
// The real directory (apps/desktop/resources/agent-skills) had 12 skills.
// `adeBundledAgentSkills` had 11 — it omitted `ade-scene`, and since that array
// is what renders the `Skills: ...` line in every provider's prompt, `ade-scene`
// existed on disk and was invisible to every agent ADE has ever run. The
// packaging roster had 9 — it omitted `ade-scene`, `ade-search` and
// `ade-mosaic`, so three skills were never checked to exist in a packaged
// build and could have stopped shipping without any gate noticing.
//
// Neither list can be derived from the directory at its own call site: the
// guidance module is bundled into the renderer and has no filesystem, and the
// packaging validators run against a built artifact, where reading the shipped
// directory to decide what should be in the shipped directory proves nothing.
// Both are therefore static mirrors, and this test is the thing that keeps them
// mirrors — it is the sync mechanism, not a description of one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUNDLED_AGENT_SKILLS } from "../../scripts/bundled-agent-skills.mjs";
import { adeBundledAgentSkills, buildAdeBootstrapGuidance } from "./adeCliGuidance";

const agentSkillsRoot = fileURLToPath(new URL("../../resources/agent-skills", import.meta.url));

/** Every skill directory that actually exists on disk. The ground truth. */
function readSkillDirectoriesOnDisk(): string[] {
  return fs
    .readdirSync(agentSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // `.claude-plugin` holds the plugin manifest, not a skill.
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("bundled agent skill rosters", () => {
  it("has a non-trivial directory to check against", () => {
    // Guards the failure mode that would make every assertion below vacuous:
    // a mistyped root resolves to an empty listing and two empty lists agree.
    const onDisk = readSkillDirectoriesOnDisk();
    expect(onDisk.length).toBeGreaterThanOrEqual(12);
    expect(onDisk).toContain("ade-cli-control-plane");
  });

  it("advertises every skill directory in the prompt-facing list", () => {
    // Fails when someone adds resources/agent-skills/<name>/ without adding
    // <name> to `adeBundledAgentSkills`. The symptom in production is silent:
    // the skill ships, no agent is ever told it exists.
    expect(sorted(adeBundledAgentSkills)).toEqual(readSkillDirectoriesOnDisk());
  });

  it("checks every skill directory in the packaged-tree validator roster", () => {
    // Fails when someone adds resources/agent-skills/<name>/ without adding
    // <name> to scripts/bundled-agent-skills.mjs, which is what
    // validate-mac-artifacts.mjs and validate-win-artifacts.mjs assert against.
    expect(sorted(BUNDLED_AGENT_SKILLS)).toEqual(readSkillDirectoriesOnDisk());
  });

  it("keeps the two rosters identical to each other", () => {
    // Redundant while both match the directory, but it names the drift
    // directly instead of leaving a reader to diff two other failures.
    expect(sorted(BUNDLED_AGENT_SKILLS)).toEqual(sorted(adeBundledAgentSkills));
  });

  it("lists no skill that has no SKILL.md on disk", () => {
    // The other direction: a name in a list with nothing behind it. In the
    // packaging validator that is a release-time failure; in the prompt it is
    // an agent told to read a skill that cannot be loaded.
    const listed = new Set([...adeBundledAgentSkills, ...BUNDLED_AGENT_SKILLS]);
    const missing = [...listed]
      .sort()
      .filter((name) => !fs.existsSync(path.join(agentSkillsRoot, name, "SKILL.md")));
    expect(missing).toEqual([]);
  });

  it("names every skill in the bootstrap guidance the providers actually receive", () => {
    // The list is only worth keeping in sync because of what it renders into.
    const bootstrap = buildAdeBootstrapGuidance([]);
    for (const skillName of readSkillDirectoriesOnDisk()) {
      expect(bootstrap).toContain(`\`${skillName}\``);
    }
  });
});
