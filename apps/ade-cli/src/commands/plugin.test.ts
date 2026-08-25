import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePluginManifestJson } from "../../../desktop/src/shared/plugins/manifest";
import { parsePluginPanel } from "../../../desktop/src/shared/plugins/vocabulary";
import {
  CliPluginUsageError,
  pluginCliUsageText,
  resolveDevTarget,
  resolvePluginCliRoute,
  runPluginCommand,
  runPluginCommandAsync,
  runPluginCreate,
  runPluginList,
  type PluginListEntry,
} from "./plugin";

let adeHome: string;
let previousAdeHome: string | undefined;

function writePlugin(
  pluginId: string,
  manifest: Record<string, unknown>,
  options: { register?: boolean; enabled?: boolean } = {},
): void {
  const root = path.join(adeHome, "plugins", pluginId);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (options.register === false) return;
  const statePath = path.join(adeHome, "plugins", "state.json");
  const state = fs.existsSync(statePath)
    ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as { version: number; plugins: Record<string, unknown> })
    : { version: 1, plugins: {} };
  state.plugins[pluginId] = {
    pluginId,
    version: manifest.version,
    enabled: options.enabled !== false,
    source: { kind: "local", path: root },
    installedAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function manifestFixture(pluginId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: pluginId,
    version: "1.0.0",
    displayName: pluginId,
    description: `${pluginId} fixture`,
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [{ kind: "tab", id: pluginId, title: pluginId, panelId: "main" }],
    panels: [{ id: "main", schemaFile: "panels/main.json" }],
    cli: ["issues"],
    ...overrides,
  };
}

beforeEach(() => {
  previousAdeHome = process.env.ADE_HOME;
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-cli-"));
  process.env.ADE_HOME = adeHome;
});

afterEach(() => {
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(adeHome, { recursive: true, force: true });
});

describe("ade plugin list", () => {
  it("reports nothing when no registry exists", () => {
    const result = runPluginList(["--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual([]);
  });

  it("lists registry entries with manifest details, in id order", () => {
    writePlugin("graph", manifestFixture("graph", { displayName: "Graph" }));
    writePlugin("annotate", manifestFixture("annotate", { displayName: "Annotate" }), { enabled: false });

    const entries = JSON.parse(runPluginList(["--json"]).output) as PluginListEntry[];
    expect(entries.map((entry) => entry.pluginId)).toEqual(["annotate", "graph"]);
    expect(entries[0]!.enabled).toBe(false);
    expect(entries[1]).toMatchObject({
      pluginId: "graph",
      version: "1.0.0",
      displayName: "Graph",
      enabled: true,
      hasEntry: true,
      cli: ["issues"],
    });
    expect(entries[1]!.errors).toEqual([]);
  });

  it("does NOT list a directory on disk that the registry does not name", () => {
    writePlugin("graph", manifestFixture("graph"));
    writePlugin("stowaway", manifestFixture("stowaway"), { register: false });

    const entries = JSON.parse(runPluginList(["--json"]).output) as PluginListEntry[];
    expect(entries.map((entry) => entry.pluginId)).toEqual(["graph"]);
  });

  it("keeps a registered plugin visible when its manifest is unreadable", () => {
    writePlugin("broken", manifestFixture("broken"));
    fs.rmSync(path.join(adeHome, "plugins", "broken", "plugin.json"));

    const entries = JSON.parse(runPluginList(["--json"]).output) as PluginListEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.errors[0]).toMatch(/plugin\.json is missing/);
  });

  it("--text renders one line per plugin", () => {
    writePlugin("graph", manifestFixture("graph", { displayName: "Graph" }));
    const output = runPluginList(["--text"]).output;
    expect(output).toBe("graph 1.0.0 — Graph (enabled)\n");
  });
});

describe("ade plugin create", () => {
  it("scaffolds a manifest the shared parser accepts with zero errors", () => {
    const result = runPluginCreate(["my-plugin", "--dir", adeHome, "--json"]);
    expect(result.exitCode).toBe(0);
    const created = JSON.parse(result.output) as { root: string; files: string[] };
    expect(created.files).toEqual(["README.md", "index.js", path.join("panels", "main.json"), "plugin.json"].sort());

    const parsed = parsePluginManifestJson(
      fs.readFileSync(path.join(created.root, "plugin.json"), "utf8"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.manifest).toMatchObject({
      name: "my-plugin",
      version: "0.1.0",
      displayName: "My Plugin",
      entry: "index.js",
      vocabVersion: 1,
    });
    expect(parsed.manifest!.surfaces).toHaveLength(1);
    expect(parsed.manifest!.panels).toHaveLength(1);
  });

  it("scaffolds an entry module and a panel the vocabulary parser accepts", () => {
    const created = JSON.parse(runPluginCreate(["my-plugin", "--dir", adeHome]).output) as { root: string };
    const entry = fs.readFileSync(path.join(created.root, "index.js"), "utf8");
    expect(entry).toContain("exports.activate");
    expect(entry).toContain("exports.actions");

    const panel = parsePluginPanel(fs.readFileSync(path.join(created.root, "panels", "main.json"), "utf8"));
    expect(panel.ok).toBe(true);
  });

  it("refuses to overwrite an existing directory", () => {
    runPluginCreate(["my-plugin", "--dir", adeHome]);
    expect(() => runPluginCreate(["my-plugin", "--dir", adeHome])).toThrowError(CliPluginUsageError);
    expect(() => runPluginCreate(["my-plugin", "--dir", adeHome])).toThrowError(/already exists/);
  });

  it("rejects a name that is not a valid plugin id", () => {
    expect(() => runPluginCreate(["My_Plugin", "--dir", adeHome])).toThrowError(/Invalid plugin id/);
    expect(() => runPluginCreate(["--dir", adeHome])).toThrowError(/ade plugin create/);
  });

  it("demonstrates the real argv and context shapes in the starter actions", () => {
    // Both shapes cost the round-2 alpha author a debugging session apiece
    // (findings #6 and #7): `argv` is a PROPERTY of the one args object, and a
    // context object carries its fields directly rather than under a `.session`
    // key. A scaffold nobody can copy a working example from is how a whole
    // class of first-plugin mistakes stays reachable.
    const created = JSON.parse(runPluginCreate(["my-plugin", "--dir", adeHome]).output) as { root: string };
    const entry = fs.readFileSync(path.join(created.root, "index.js"), "utf8");

    expect(entry).toContain("const argv = args.argv");
    expect(entry).not.toMatch(/async\s+status\s*\(\s*argv\s*\)/);
    expect(entry).toContain("const context = args.context;");
    // The wrong form appears once, named as wrong, in a comment. Nowhere else.
    expect(entry).toContain("never\n// `args.context.session.id`");
    const code = entry.split("\n").filter((line) => !line.trim().startsWith("//"));
    expect(code.join("\n")).not.toContain("args.context.session");

    // The starter declares a socket, so `hello` is a press someone can make.
    const parsed = parsePluginManifestJson(
      fs.readFileSync(path.join(created.root, "plugin.json"), "utf8"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest!.sockets).toEqual([
      { socket: "toolbar-action", surface: "app", id: "hello", label: "My Plugin", actionId: "hello" },
    ]);
  });
});

describe("ade plugin dev target", () => {
  it("watches the folder a local install came from, never the installed copy", () => {
    // Watching the installed copy is a reload loop now that a reload rewrites
    // that copy from the source: the write wakes the watcher, which reloads,
    // which writes again.
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-src-"));
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify(manifestFixture("graph")),
      "utf8",
    );
    writePlugin("graph", manifestFixture("graph"));
    const statePath = path.join(adeHome, "plugins", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      plugins: Record<string, { source: unknown }>;
    };
    state.plugins.graph!.source = { kind: "local", path: source };
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

    expect(resolveDevTarget("graph")).toEqual({ pluginId: "graph", root: source });
    fs.rmSync(source, { recursive: true, force: true });
  });

  it("falls back to the installed copy for a source that is not a local folder", () => {
    writePlugin("graph", manifestFixture("graph"));
    const statePath = path.join(adeHome, "plugins", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      plugins: Record<string, { source: unknown }>;
    };
    state.plugins.graph!.source = { kind: "git", url: "https://example.test/graph.git" };
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

    expect(resolveDevTarget("graph")).toEqual({
      pluginId: "graph",
      root: path.join(adeHome, "plugins", "graph"),
    });
  });
});

describe("ade plugin dispatch", () => {
  it("prints help with no args", () => {
    const result = runPluginCommand([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ade plugin list");
    expect(result.output).toContain("ade plugin dev");
  });

  it("rejects an unknown subcommand with a usage error", () => {
    expect(() => runPluginCommand(["frobnicate"])).toThrowError(CliPluginUsageError);
    expect(() => runPluginCommand(["frobnicate"])).toThrowError(/Unknown plugin subcommand/);
  });

  it("never falls through to the file watcher for a misspelled subcommand", async () => {
    // `dev` blocks until SIGINT, so a dispatch that reached it by default would
    // hang the CLI on a typo rather than saying the word does not exist.
    await expect(
      runPluginCommandAsync(["instal", "."], { invokeAction: async () => ({}) }),
    ).rejects.toThrowError(/Unknown plugin subcommand/);
  });

  it("tells the caller when a daemon-backed subcommand is run without the brain", () => {
    expect(() => runPluginCommand(["enable", "graph"])).toThrowError(/needs the ADE brain/);
  });

  it("routes daemon-backed subcommands through the plugin action domain", async () => {
    const calls: { action: string; args: Record<string, unknown> }[] = [];
    const invokeAction = async (action: string, args: Record<string, unknown>) => {
      calls.push({ action, args });
      return { pluginId: "graph", version: "1.0.0", displayName: "Graph", enabled: true };
    };

    await runPluginCommandAsync(["enable", "graph", "--json"], { invokeAction });
    await runPluginCommandAsync(["remove", "graph"], { invokeAction });
    await runPluginCommandAsync(["install", "https://example.com/g.git", "--ref", "v1", "--no-enable"], {
      invokeAction,
    });

    expect(calls).toEqual([
      { action: "enable", args: { pluginId: "graph" } },
      { action: "uninstall", args: { pluginId: "graph" } },
      { action: "install", args: { source: "https://example.com/g.git", ref: "v1", enable: false } },
    ]);
  });

  it("says when an install has changed how agents behave, and from when", async () => {
    // The retrospective's sharpest confusion: the plugin was installed and the
    // agent already answering stayed exactly as it was.
    writePlugin("tipsy", manifestFixture("tipsy", { skills: ["skills/tipsy"] }));
    writePlugin("graph", manifestFixture("graph"));
    const invokeAction = async (_action: string, _args: Record<string, unknown>) => ({
      pluginId: "tipsy",
      version: "1.0.0",
      displayName: "Tipsy",
      enabled: true,
    });

    const withSkill = await runPluginCommandAsync(["install", "/src/tipsy", "--text"], { invokeAction });
    expect(withSkill.output).toContain("Affects agents from their next turn");

    // A plugin that ships no skill changes no agent, and says nothing about it.
    const withoutSkill = await runPluginCommandAsync(["install", "/src/graph", "--text"], {
      invokeAction: async () => ({ pluginId: "graph", version: "1.0.0", displayName: "Graph", enabled: true }),
    });
    expect(withoutSkill.output).not.toContain("next turn");

    // JSON stays the action result verbatim: it is a contract, not a message.
    const asJson = await runPluginCommandAsync(["install", "/src/tipsy", "--json"], { invokeAction });
    expect(asJson.output).not.toContain("next turn");
  });

  it("walks the state ladder for one plugin, and degrades where ADE cannot answer", async () => {
    writePlugin("tipsy", manifestFixture("tipsy", {
      sockets: [
        { socket: "composer-action", surface: "work", id: "drink", label: "Take a drink", actionId: "drink" },
      ],
    }));
    const result = await runPluginCommandAsync(["doctor", "tipsy", "--text"], {
      invokeAction: async (action) => {
        if (action === "get") return { pluginId: "tipsy", status: "running", hasEntry: true };
        // Everything else fails: a doctor run while things are broken must
        // still print the rungs it could reach.
        throw new Error("no");
      },
    });
    expect(result.output).toContain("✓ Source");
    expect(result.output).toContain("✓ Installed here");
    expect(result.output).toContain("✓ Running");
    expect(result.output).toContain("composer-action in work");
    expect(result.output).toContain("Renders on: desktop ✓");
    expect(result.exitCode).toBe(0);
  });

  it("doctor answers with the app closed, saying which rungs went unchecked", async () => {
    writePlugin("tipsy", manifestFixture("tipsy"));
    const result = await runPluginCommandAsync(["doctor", "tipsy", "--text"], {
      invokeAction: async () => {
        throw new Error("connect ENOENT");
      },
    });
    expect(result.output).toContain("✓ Installed here");
    expect(result.output).toContain("could not ask ADE");
  });

  it("logs reads the plugin detail and honors --limit", async () => {
    const logs = Array.from({ length: 5 }, (_, index) => ({
      at: `2026-08-11T00:00:0${index}.000Z`,
      level: "info" as const,
      message: `line ${index}`,
    }));
    const result = await runPluginCommandAsync(["logs", "graph", "--limit", "2", "--json"], {
      invokeAction: async (action) => {
        expect(action).toBe("get");
        return { pluginId: "graph", logs };
      },
    });
    expect(JSON.parse(result.output)).toEqual(logs.slice(-2));
  });

  it("rejects a non-positive --limit", async () => {
    await expect(
      runPluginCommandAsync(["logs", "graph", "--limit", "0"], { invokeAction: async () => ({}) }),
    ).rejects.toThrowError(/--limit must be a positive integer/);
  });
});

describe("ade plugin registry reading", () => {
  it("reads a source kind this build does not know as a builtin, keeping the OFF list", () => {
    writePlugin("graph", manifestFixture("graph"));
    const statePath = path.join(adeHome, "plugins", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      plugins: Record<string, Record<string, unknown>>;
    };
    state.plugins.graph = {
      ...state.plugins.graph,
      source: { kind: "marketplace-v2", url: "https://example.test/g.git" },
      disabledContributions: ["issues-badge"],
    };
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

    const entries = JSON.parse(runPluginList(["--json"]).output) as PluginListEntry[];
    // Unknown reads as builtin, not as a local path: a builtin is re-seeded
    // from the bundle rather than re-cloned from something the record failed to
    // describe. And the user's switched-off contributions survive the read.
    expect(entries[0]?.source).toEqual({ kind: "builtin" });
    expect(entries[0]?.disabledContributions).toEqual(["issues-badge"]);
  });
});

describe("ade <plugin-id> <command> routing", () => {
  it("claims a word an installed, enabled plugin declares", () => {
    writePlugin("graph", manifestFixture("graph", { cli: ["issues", "open"] }));
    expect(resolvePluginCliRoute("graph", ["issues", "--text"])).toEqual({
      pluginId: "graph",
      command: "issues",
    });
    expect(resolvePluginCliRoute("graph", [])).toEqual({ pluginId: "graph", command: null });
  });

  it("declines a typo so the caller can keep its Unknown command error", () => {
    writePlugin("lanes-plus", manifestFixture("lanes-plus"));
    expect(resolvePluginCliRoute("lnes", [])).toBeNull();
    expect(resolvePluginCliRoute("graph", ["issues"])).toBeNull();
  });

  it("declines a word the plugin never declared", () => {
    writePlugin("graph", manifestFixture("graph", { cli: ["issues"] }));
    expect(resolvePluginCliRoute("graph", ["nuke"])).toBeNull();
  });

  it("declines a disabled plugin, an id-shaped non-id, and a plugin with no cli words", () => {
    writePlugin("graph", manifestFixture("graph"), { enabled: false });
    writePlugin("quiet", manifestFixture("quiet", { cli: [] }));
    expect(resolvePluginCliRoute("graph", ["issues"])).toBeNull();
    expect(resolvePluginCliRoute("quiet", [])).toBeNull();
    expect(resolvePluginCliRoute("Graph", ["issues"])).toBeNull();
    expect(resolvePluginCliRoute("../etc", [])).toBeNull();
  });

  it("answers a bare id from the manifest instead of calling the plugin", () => {
    writePlugin("graph", manifestFixture("graph", { cli: ["issues", "open"] }));

    const usage = pluginCliUsageText("graph");
    expect(usage).toContain("ade graph issues");
    expect(usage).toContain("ade graph open");
    expect(usage).toContain("ade plugin logs graph");
  });
});
