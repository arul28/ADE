import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkillCommands, frontmatterFlag, resolveSkillCommandFile } from "./markdownSlashCommandDiscovery";

describe("frontmatterFlag", () => {
  // The bug: the `yaml` package parses YAML 1.2 core, where only `true`/`false`
  // are booleans. `user-invocable: no` stayed the STRING "no" — truthy — so a
  // skill written the YAML 1.1 way every other harness accepts stayed invocable
  // and was advertised to the model.
  // Anything unrecognized stays undefined so the caller picks its own default.
  it.each([
    [false, [false, 0, "false", "False", "FALSE", "no", "No", "off", "OFF", "0", " no "]],
    [true, [true, 1, "true", "True", "yes", "YES", "on", "1", " yes "]],
    [undefined, [undefined, null, "", "maybe", "2", 2, -1, {}, []]],
  ])("reads every conventional %s spelling", (expected, values: unknown[]) => {
    for (const value of values) expect(frontmatterFlag(value)).toBe(expected);
  });
});

describe("discoverSkillCommands boolean frontmatter", () => {
  let skillsDir = "";

  const writeSkill = (name: string, frontmatter: string[]): void => {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      ["---", `name: ${name}`, "description: Probe", ...frontmatter, "---", "", "Body.", ""].join("\n"),
      "utf8",
    );
  };

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-frontmatter-"));
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("hides a skill whose user-invocable reads false, including the YAML 1.1 spelling", () => {
    writeSkill("hidden-no", ["user-invocable: no"]);
    writeSkill("hidden-quoted", ["user-invocable: \"no\""]);
    writeSkill("shown", ["user-invocable: yes"]);

    expect(discoverSkillCommands(skillsDir).map((entry) => entry.name)).toEqual(["/shown"]);
  });

  it("keeps a skill listed but model-hidden only when disable-model-invocation reads true", () => {
    writeSkill("tool-only", ["disable-model-invocation: yes"]);
    writeSkill("open", ["disable-model-invocation: no"]);

    expect(discoverSkillCommands(skillsDir).map((entry) => [entry.name, entry.modelInvocable]))
      .toEqual([["/open", true], ["/tool-only", false]]);
  });

  it("still lists a hidden skill when the caller opts out of the flag", () => {
    writeSkill("hidden", ["user-invocable: off"]);

    expect(discoverSkillCommands(skillsDir, { respectUserInvocable: false }).map((e) => e.name))
      .toEqual(["/hidden"]);
  });

  // The slash-menu filter and the invocation resolver have to agree, or a
  // command the menu hides is still runnable by typing its name.
  it("refuses to resolve a skill hidden by a YAML 1.1 false spelling", () => {
    writeSkill("hidden", ["user-invocable: no"]);
    writeSkill("shown", []);

    expect(resolveSkillCommandFile(skillsDir, "hidden")).toBeNull();
    expect(resolveSkillCommandFile(skillsDir, "shown")).toContain(path.join("shown", "SKILL.md"));
  });
});
