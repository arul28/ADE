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
 * Three skills describe surfaces an official plugin SUPERSEDES, and they ship
 * twice: once compiled into ADE, once inside the plugin package. With no plugin
 * installed the compiled copy is the product, exactly as before the plugin
 * existed. Install the plugin and its own copy replaces the compiled one, and
 * the name is still listed exactly once — an agent that sees a skill twice
 * cannot tell which one it opened.
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

  it("keeps the compiled ade-linear skill when the ade-linear plugin is not installed", () => {
    adeHomeWithInstalledPlugins([]);

    // Supersedes, not enables: a machine without the plugin is the product ADE
    // has always been, and the compiled skill is what it serves.
    expect(listedSkillNames()).toContain("ade-linear");
    const shown = runSkillShow(["ade-linear", "--json"]) as { output: string; exitCode: number };
    expect(shown.exitCode).toBe(0);
    expect((JSON.parse(shown.output) as { path: string }).path)
      .not.toContain(path.join("plugins", "ade-linear", "skills"));
  });

  it("serves the plugin's own ade-linear skill once its plugin is installed", () => {
    adeHomeWithInstalledPlugins(["ade-linear"]);

    // Listed exactly once, and it is the plugin's copy — the compiled one steps
    // aside the same way the compiled UI does.
    expect(listedSkillNames().filter((name) => name === "ade-linear")).toEqual(["ade-linear"]);
    const shown = runSkillShow(["ade-linear", "--json"]) as { output: string; exitCode: number };
    expect(shown.exitCode).toBe(0);
    expect((JSON.parse(shown.output) as { path: string }).path)
      .toContain(path.join("plugins", "ade-linear", "skills", "ade-linear"));
  });

  it("supersedes ade-ios-simulator and leaves ade-app-control compiled", () => {
    adeHomeWithInstalledPlugins(["ade-ios-sim"]);

    // The skill directory and the plugin id are deliberately different words.
    const names = listedSkillNames();
    expect(names.filter((name) => name === "ade-ios-simulator")).toEqual(["ade-ios-simulator"]);
    // No `ade-app-control` plugin here, so ADE's compiled skill is still the one.
    expect(names).toContain("ade-app-control");
    const control = runSkillShow(["ade-app-control", "--json"]) as { output: string; exitCode: number };
    expect((JSON.parse(control.output) as { path: string }).path)
      .not.toContain(path.join("plugins", "ade-app-control", "skills"));
    const simulator = runSkillShow(["ade-ios-simulator", "--json"]) as { output: string; exitCode: number };
    expect((JSON.parse(simulator.output) as { path: string }).path)
      .toContain(path.join("plugins", "ade-ios-sim", "skills", "ade-ios-simulator"));
  });

  /**
   * Claude never reads `ADE_AGENT_SKILLS_DIRS`. A plugin-owned skill reaches a
   * Claude runtime only as a Claude PLUGIN root, and `canonicalClaudePluginRoot`
   * in the desktop `agentSkillRuntimeService` accepts a root only when it holds
   * a `.claude-plugin/plugin.json`. Without the marker the skill loads on every
   * other runtime and silently never loads on Claude, which is the failure that
   * is hardest to notice.
   */
  it("gives every plugin skills root the Claude plugin marker", () => {
    const pluginIds = fs
      .readdirSync(repoPluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((pluginId) => fs.existsSync(path.join(repoPluginsRoot, pluginId, "skills")));

    expect(pluginIds.length).toBeGreaterThan(0);
    for (const pluginId of pluginIds) {
      const marker = path.join(repoPluginsRoot, pluginId, "skills", ".claude-plugin", "plugin.json");
      expect(fs.existsSync(marker), `${pluginId} is missing ${marker}`).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { name?: string; skills?: string };
      expect(parsed.name).toBe(pluginId);
      // The skills live directly under the root the marker sits in.
      expect(parsed.skills).toBe("./");
    }
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
