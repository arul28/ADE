import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

/**
 * The catalogue has to answer the same way the runtimes do.
 *
 * Three skills describe surfaces an official plugin owns and ship inside that
 * plugin's package, so they exist on a machine only while the plugin is
 * installed. `ade skill list` reads the installed-plugin roots for exactly that
 * reason: an agent that is told a skill exists and then cannot open it is worse
 * off than one that was never told.
 */
describe("plugin-owned skills follow the install state", () => {
  const repoPluginsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../plugins",
  );
  const scratchDirs: string[] = [];
  // Vitest may itself be running inside an ADE session, which exports the
  // INSTALLED app's skills root; that root is a released build and still holds
  // the pre-move copies. Scope the run to this machine's plugin registry.
  const overridden = ["ADE_HOME", "ADE_AGENT_SKILLS_DIRS", "ADE_BUNDLED_AGENT_SKILLS_DIR"] as const;
  const previousEnv = new Map(overridden.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  /** An `~/.ade` whose plugin registry lists exactly `pluginIds` as installed. */
  function adeHomeWithInstalledPlugins(pluginIds: readonly string[]): string {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-cli-"));
    scratchDirs.push(adeHome);
    const pluginsRoot = path.join(adeHome, "plugins");
    fs.mkdirSync(pluginsRoot, { recursive: true });
    const plugins: Record<string, unknown> = {};
    for (const pluginId of pluginIds) {
      fs.cpSync(path.join(repoPluginsRoot, pluginId), path.join(pluginsRoot, pluginId), { recursive: true });
      plugins[pluginId] = {
        pluginId,
        version: "1.0.0",
        enabled: true,
        source: { kind: "builtin" },
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }
    fs.writeFileSync(path.join(pluginsRoot, "state.json"), JSON.stringify({ version: 2, plugins }));
    process.env.ADE_HOME = adeHome;
    delete process.env.ADE_AGENT_SKILLS_DIRS;
    delete process.env.ADE_BUNDLED_AGENT_SKILLS_DIR;
    return adeHome;
  }

  function listedSkillNames(): string[] {
    return (JSON.parse(runSkillList(["--json"]).output) as Array<{ name: string }>)
      .map((entry) => entry.name);
  }

  it("omits ade-linear when the ade-linear plugin is not installed", () => {
    adeHomeWithInstalledPlugins([]);

    expect(listedSkillNames()).not.toContain("ade-linear");
    expect(() => runSkillShow(["ade-linear"])).toThrowError(/Unknown skill/);
  });

  it("lists and shows ade-linear once its plugin is installed", () => {
    adeHomeWithInstalledPlugins(["ade-linear"]);

    expect(listedSkillNames()).toContain("ade-linear");
    const shown = runSkillShow(["ade-linear", "--json"]) as { output: string; exitCode: number };
    expect(shown.exitCode).toBe(0);
    expect((JSON.parse(shown.output) as { path: string }).path)
      .toContain(path.join("plugins", "ade-linear", "skills", "ade-linear"));
  });

  it("gates ade-ios-simulator and ade-app-control on their own plugins", () => {
    adeHomeWithInstalledPlugins(["ade-ios-sim"]);

    // The skill directory and the plugin id are deliberately different words.
    expect(listedSkillNames()).toContain("ade-ios-simulator");
    expect(listedSkillNames()).not.toContain("ade-app-control");
  });

  it("keeps the ungated bundled skills present whatever is installed", () => {
    for (const installed of [[], ["ade-linear"]] as const) {
      adeHomeWithInstalledPlugins(installed);
      const names = listedSkillNames();
      expect(names).toContain("ade-cli-control-plane");
      expect(names).toContain("ade-browser");
    }
  });
});
