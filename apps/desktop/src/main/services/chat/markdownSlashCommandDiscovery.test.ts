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
  it("reads every conventional false spelling as false", () => {
    for (const value of [false, 0, "false", "False", "FALSE", "no", "No", "off", "OFF", "0", " no "]) {
      expect(frontmatterFlag(value)).toBe(false);
    }
  });

  it("reads every conventional true spelling as true", () => {
    for (const value of [true, 1, "true", "True", "yes", "YES", "on", "1", " yes "]) {
      expect(frontmatterFlag(value)).toBe(true);
    }
  });

  it("leaves anything unrecognized undefined so the caller picks its own default", () => {
    for (const value of [undefined, null, "", "maybe", "2", 2, -1, {}, []]) {
      expect(frontmatterFlag(value)).toBeUndefined();
    }
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

  it("hides a skill for every YAML 1.1 false spelling of user-invocable", () => {
    for (const [label, value] of [["no", "no"], ["off", "off"], ["zero", "0"], ["plain", "false"], ["quoted", "\"no\""]]) {
      writeSkill(`hidden-${label}`, [`user-invocable: ${value}`]);
    }
    writeSkill("shown", ["user-invocable: yes"]);

    const names = discoverSkillCommands(skillsDir).map((entry) => entry.name);

    expect(names).toEqual(["/shown"]);
  });

  it("keeps a skill listed but model-hidden for every true spelling of disable-model-invocation", () => {
    for (const [label, value] of [["yes", "yes"], ["on", "on"], ["one", "1"], ["plain", "true"]]) {
      writeSkill(`tool-only-${label}`, [`disable-model-invocation: ${value}`]);
    }

    const commands = discoverSkillCommands(skillsDir);

    expect(commands).toHaveLength(4);
    expect(commands.every((entry) => entry.modelInvocable === false)).toBe(true);
  });

  it("leaves a skill model-invocable when disable-model-invocation reads false", () => {
    for (const [label, value] of [["no", "no"], ["off", "off"], ["zero", "0"], ["plain", "false"]]) {
      writeSkill(`open-${label}`, [`disable-model-invocation: ${value}`]);
    }

    const commands = discoverSkillCommands(skillsDir);

    expect(commands).toHaveLength(4);
    expect(commands.every((entry) => entry.modelInvocable === true)).toBe(true);
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
