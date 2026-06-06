import { describe, expect, it } from "vitest";

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

  it("list --text emits one name — description line per skill", () => {
    const result = runSkillList(["--text"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/ade-browser —/);
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
