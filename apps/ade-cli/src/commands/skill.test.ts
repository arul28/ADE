import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentSkillFileError,
  isRemoteMcpInvocation,
  listAgentSkills,
  readAgentSkill,
  readAgentSkillFile,
} from "../services/skills/agentSkillCatalogService";
import { CliSkillUsageError, runSkillCommand, runSkillList, runSkillShow } from "./skill";

describe("ade skill (bundled agent skills)", () => {
  it("list --json returns entries for known bundled skills", () => {
    const result = runSkillList(["--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as Array<{
      name: string;
      description: string;
      path: string;
    }>;
    const names = parsed.map((entry) => entry.name);
    expect(names).toContain("ade-browser");
    expect(names).toContain("ade-cli-control-plane");
    // Sorted + each entry carries a path to a SKILL.md.
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    for (const entry of parsed) {
      expect(entry.path).toMatch(/SKILL\.md$/);
    }
  });

  it("list --text emits one name [source] — description line per skill", () => {
    const result = runSkillList(["--text"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/ade-browser \[(?:bundled|project)\] —/);
  });

  it("an ADE MCP call never lists or shows a personal skill, even through a project folder linking to it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-privacy-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const writeSkill = (dir: string, name: string) => {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.\n`);
    };
    try {
      writeSkill(path.join(home, ".claude", "skills"), "secret-notes");
      writeSkill(path.join(project, ".claude", "skills"), "project-guide");
      fs.mkdirSync(path.join(project, ".agents"), { recursive: true });
      fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(project, ".agents", "skills"), "junction");
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const local = listAgentSkills({ cwd: project, includeUser: true, env });
      const remoteEnv = { ...env, ADE_REMOTE_MCP_CONNECTION_ID: "conn-1" };
      const remote = listAgentSkills({ cwd: project, includeUser: !isRemoteMcpInvocation(remoteEnv), env: remoteEnv });

      // On the computer itself the person sees every skill, theirs included.
      expect(local.map((entry) => entry.name)).toContain("secret-notes");
      expect(remote.find((entry) => entry.name === "project-guide")?.source).toBe("project");
      expect(remote.map((entry) => entry.name)).not.toContain("secret-notes");
      expect(readAgentSkill("secret-notes", { cwd: project, includeUser: false, env: remoteEnv })).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // `skill show <name> <file>` is read-only over ADE MCP, so a skill folder a
  // repo controls must not become a way to read, or probe for, other files.
  it("reads a skill's own Markdown files and nothing outside its folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-file-"));
    const project = path.join(root, "project");
    const skillDir = path.join(project, ".claude", "skills", "guide");
    try {
      fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: guide\ndescription: guide skill\n---\nBody.\n");
      fs.writeFileSync(path.join(skillDir, "references", "detail.md"), "# Detail\n");
      fs.writeFileSync(path.join(root, "outside.md"), "secret\n");
      fs.symlinkSync(path.join(root, "outside.md"), path.join(skillDir, "references", "leak.md"));
      const skill = readAgentSkill("guide", { cwd: project, includeUser: false, env: process.env });
      expect(skill, "setup precondition: the project skill is found").not.toBeNull();

      expect(readAgentSkillFile(skill!.entry, "references/detail.md").content).toBe("# Detail\n");
      const refusal = (file: string): string => {
        try {
          readAgentSkillFile(skill!.entry, file);
        } catch (error) {
          expect(error).toBeInstanceOf(AgentSkillFileError);
          return (error as Error).message;
        }
        throw new Error(`${file} was read`);
      };
      // An escaping path reads the same whether or not the file exists.
      const outside = "is not a Markdown file inside the guide skill";
      for (const file of ["../../../../outside.md", "../../../../missing.md", "references/leak.md", path.join(root, "outside.md"), "SKILL"]) {
        expect(refusal(file), file).toContain(outside);
      }
      expect(refusal("references/missing.md")).toContain("has no file");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("show <name> --json returns full content including frontmatter name", () => {
    const result = runSkillShow(["ade-browser", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as {
      name: string;
      description: string;
      content: string;
      path: string;
    };
    expect(parsed.name).toBe("ade-browser");
    expect(parsed.content).toContain("name: ade-browser");
    expect(parsed.content).toContain("---");
  });

  it("show <name> --text prints the markdown body without frontmatter delimiters at the top", () => {
    const result = runSkillShow(["ade-browser", "--text"]);
    expect(result.exitCode).toBe(0);
    expect(result.output.trimStart().startsWith("---")).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("show errors clearly for an unknown skill and lists available names", () => {
    expect(() => runSkillShow(["does-not-exist"])).toThrowError(/Unknown skill/);
    try {
      runSkillShow(["does-not-exist"]);
    } catch (error) {
      expect((error as Error).message).toContain("ade-browser");
    }
  });

  it("top-level dispatch prints help with no args", () => {
    const result = runSkillCommand([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ade skill list");
  });

  it("top-level dispatch rejects an unknown subcommand with a usage error", () => {
    expect(() => runSkillCommand(["frobnicate"])).toThrowError(CliSkillUsageError);
    expect(() => runSkillCommand(["frobnicate"])).toThrowError(/Unknown skill subcommand/);
  });
});
