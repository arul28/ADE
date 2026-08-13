import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { z } from "zod";

import { parsePluginManifest, type PluginManifestTool } from "../../../shared/plugins/manifest";
import {
  createPluginAgentToolMap,
  listPluginAgentToolDeclarations,
  pluginAgentToolName,
  zodForPluginTool,
} from "./pluginAgentTools";
import { listPluginAgentSkillRoots } from "./pluginInstallService";

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function scratchPluginsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-tools-"));
  scratchDirs.push(dir);
  const root = path.join(dir, "plugins");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ version: 2, plugins: {} }), "utf8");
  return root;
}

/** Write a plugin directory and its registry entry, the way an install would. */
function installFixture(
  pluginsRoot: string,
  pluginId: string,
  manifest: Record<string, unknown>,
  options: { enabled?: boolean } = {},
): string {
  const pluginRoot = path.join(pluginsRoot, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "plugin.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0", displayName: pluginId, ...manifest }),
    "utf8",
  );
  const statePath = path.join(pluginsRoot, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { plugins: Record<string, unknown> };
  state.plugins[pluginId] = {
    version: "1.0.0",
    enabled: options.enabled !== false,
    source: { kind: "local", path: pluginRoot },
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  return pluginRoot;
}

function setPluginEnabled(pluginsRoot: string, pluginId: string, enabled: boolean): void {
  const statePath = path.join(pluginsRoot, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    plugins: Record<string, { enabled: boolean }>;
  };
  state.plugins[pluginId]!.enabled = enabled;
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
}

const echoTool = {
  name: "echo",
  description: "Repeat a phrase back.",
  input: {
    type: "object",
    properties: {
      phrase: { type: "string", description: "What to repeat." },
      times: { type: "integer" },
    },
    required: ["phrase"],
  },
} as const;

describe("parsing tool declarations", () => {
  it("keeps a well-formed tool and defaults its action to its name", () => {
    const { manifest, errors } = parsePluginManifest({
      name: "demo",
      version: "1.0.0",
      tools: [echoTool],
    });

    expect(errors).toEqual([]);
    expect(manifest?.tools).toEqual([
      {
        name: "echo",
        description: "Repeat a phrase back.",
        input: {
          type: "object",
          properties: {
            phrase: { type: "string", description: "What to repeat." },
            times: { type: "integer" },
          },
          required: ["phrase"],
        },
        action: "echo",
      },
    ]);
  });

  it("drops a tool whose schema leaves the supported subset, and says which", () => {
    const { manifest, warnings } = parsePluginManifest({
      name: "demo",
      version: "1.0.0",
      tools: [
        echoTool,
        {
          name: "risky",
          description: "Takes anything.",
          input: { type: "object", properties: { any: { oneOf: [{ type: "string" }] } } },
        },
      ],
    });

    // The good tool survives; a half-described one would be worse than absent,
    // because the agent would call it and the plugin would get nonsense.
    expect(manifest?.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(warnings.join(" ")).toContain("tools[1].input.properties.any.type");
  });

  it("refuses a required name that no property declares", () => {
    const { manifest } = parsePluginManifest({
      name: "demo",
      version: "1.0.0",
      tools: [{
        name: "broken",
        description: "Mismatched.",
        input: { type: "object", properties: { a: { type: "string" } }, required: ["b"] },
      }],
    });

    expect(manifest?.tools).toEqual([]);
  });

  it("keeps the first of two tools sharing a name", () => {
    const { manifest, warnings } = parsePluginManifest({
      name: "demo",
      version: "1.0.0",
      tools: [
        echoTool,
        { ...echoTool, description: "A second echo." },
      ],
    });

    expect(manifest?.tools).toHaveLength(1);
    expect(manifest?.tools[0]?.description).toBe("Repeat a phrase back.");
    expect(warnings.join(" ")).toContain("more than once");
  });

  it("caps how many tools one plugin may declare", () => {
    const { manifest, warnings } = parsePluginManifest({
      name: "demo",
      version: "1.0.0",
      tools: Array.from({ length: 40 }, (_, index) => ({
        ...echoTool,
        name: `echo${index}`,
      })),
    });

    expect(manifest?.tools).toHaveLength(24);
    expect(warnings.join(" ")).toContain("more than 24 tools");
  });
});

describe("declaration to zod", () => {
  function toolFrom(raw: Record<string, unknown>): PluginManifestTool {
    const parsed = parsePluginManifest({ name: "demo", version: "1.0.0", tools: [raw] });
    const tool = parsed.manifest?.tools[0];
    if (!tool) throw new Error(`fixture tool did not parse: ${parsed.warnings.join("; ")}`);
    return tool;
  }

  it("makes declared-required properties required and the rest optional", () => {
    const schema = zodForPluginTool(toolFrom(echoTool));

    expect(schema.safeParse({ phrase: "hi" }).success).toBe(true);
    expect(schema.safeParse({ phrase: "hi", times: 2 }).success).toBe(true);
    expect(schema.safeParse({ times: 2 }).success).toBe(false);
    expect(schema.safeParse({ phrase: "hi", times: 1.5 }).success).toBe(false);
  });

  it("strips undeclared arguments instead of failing the call", () => {
    const schema = zodForPluginTool(toolFrom(echoTool));

    // A model that invents an extra key should not have the whole tool call
    // fail on a message it cannot act on — and the plugin never sees the key.
    expect(schema.parse({ phrase: "hi", hallucinated: true })).toEqual({ phrase: "hi" });
  });

  it("carries enums, arrays and nested objects through to JSON Schema", () => {
    const schema = zodForPluginTool(toolFrom({
      name: "search",
      description: "Search.",
      input: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "deep"] },
          tags: { type: "array", items: { type: "string" } },
          window: {
            type: "object",
            properties: { start: { type: "string" }, limit: { type: "number" } },
            required: ["start"],
          },
        },
        required: ["mode"],
      },
    }));

    expect(schema.safeParse({ mode: "sideways" }).success).toBe(false);
    expect(schema.safeParse({ mode: "deep", tags: ["a"], window: { start: "x" } }).success).toBe(true);
    expect(schema.safeParse({ mode: "deep", window: { limit: 1 } }).success).toBe(false);

    // Codex is served a JSON Schema regenerated from this Zod, so the round
    // trip has to preserve the constraints the manifest declared.
    const json = z.toJSONSchema(schema) as {
      properties: Record<string, { enum?: string[]; type?: string }>;
      required?: string[];
    };
    expect(json.properties.mode?.enum).toEqual(["fast", "deep"]);
    expect(json.properties.tags?.type).toBe("array");
    expect(json.required).toEqual(["mode"]);
  });
});

describe("the tool set follows install state", () => {
  it("lists nothing when no plugin declares a tool", () => {
    const pluginsRoot = scratchPluginsRoot();
    installFixture(pluginsRoot, "quiet", {});

    expect(listPluginAgentToolDeclarations({ pluginsRoot })).toEqual([]);
    expect(createPluginAgentToolMap({
      listDeclarations: () => listPluginAgentToolDeclarations({ pluginsRoot }),
    })).toBeNull();
  });

  it("names each tool after the plugin that serves it", () => {
    const pluginsRoot = scratchPluginsRoot();
    installFixture(pluginsRoot, "notes", { displayName: "Notes", tools: [echoTool] });

    const tools = createPluginAgentToolMap({
      listDeclarations: () => listPluginAgentToolDeclarations({ pluginsRoot }),
    });

    expect(Object.keys(tools ?? {})).toEqual(["plugin__notes__echo"]);
    // Attribution twice over: the runtimes that show a tool's description but
    // not the server it came from still name the plugin.
    expect(tools?.["plugin__notes__echo"]?.description).toContain("Notes plugin");
  });

  it("drops a disabled plugin's tools from the next listing", () => {
    const pluginsRoot = scratchPluginsRoot();
    installFixture(pluginsRoot, "notes", { tools: [echoTool] });
    const listDeclarations = () => listPluginAgentToolDeclarations({ pluginsRoot });

    expect(Object.keys(createPluginAgentToolMap({ listDeclarations }) ?? {})).toHaveLength(1);

    setPluginEnabled(pluginsRoot, "notes", false);

    expect(listDeclarations()).toEqual([]);
    expect(createPluginAgentToolMap({ listDeclarations })).toBeNull();
  });

  it("ignores a plugin whose manifest will not parse", () => {
    const pluginsRoot = scratchPluginsRoot();
    const pluginRoot = installFixture(pluginsRoot, "broken", { tools: [echoTool] });
    fs.writeFileSync(path.join(pluginRoot, "plugin.json"), "{ not json", "utf8");

    expect(listPluginAgentToolDeclarations({ pluginsRoot })).toEqual([]);
  });
});

describe("invoking a plugin tool", () => {
  // Built through the real parser rather than hand-written, so the fixture
  // cannot drift from what a manifest can actually declare.
  const echoDeclaration: PluginManifestTool = (() => {
    const parsed = parsePluginManifest({
      name: "notes",
      version: "1.0.0",
      tools: [{ ...echoTool, action: "echoHandler" }],
    });
    const tool = parsed.manifest?.tools[0];
    if (!tool) throw new Error(`fixture tool did not parse: ${parsed.warnings.join("; ")}`);
    return tool;
  })();

  const declarations = (pluginId: string) => [{
    pluginId,
    displayName: "Notes",
    tool: echoDeclaration,
  }];

  it("proxies to plugin.invoke with the agent's arguments and returns the result", async () => {
    const invoke = vi.fn().mockResolvedValue({ said: "hello", count: 2 });
    const tools = createPluginAgentToolMap({
      listDeclarations: () => declarations("notes"),
      invoke,
      isLive: () => true,
    });
    const tool = tools?.[pluginAgentToolName("notes", "echo")];

    const args = tool!.inputSchema.parse({ phrase: "hello", times: 2 });
    const result = await tool!.execute(args);

    // The declared `action`, not the tool word — a plugin may name its handler
    // differently from the verb the agent sees.
    expect(invoke).toHaveBeenCalledWith({
      pluginId: "notes",
      action: "echoHandler",
      args: { phrase: "hello", times: 2 },
    });
    expect(result).toEqual({ said: "hello", count: 2 });
  });

  it("surfaces the plugin's own failure rather than swallowing it", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("handler blew up"));
    const tools = createPluginAgentToolMap({
      listDeclarations: () => declarations("notes"),
      invoke,
      isLive: () => true,
    });

    await expect(tools!["plugin__notes__echo"]!.execute({ phrase: "x" }))
      .rejects.toThrow("handler blew up");
  });

  it("refuses an in-flight call to a plugin that was just removed", async () => {
    const invoke = vi.fn();
    let live = true;
    const tools = createPluginAgentToolMap({
      listDeclarations: () => declarations("notes"),
      invoke,
      isLive: () => live,
    });

    live = false;

    // The agent must read "this machine does not have that plugin", not a
    // transport error it will treat as a bug and retry.
    await expect(tools!["plugin__notes__echo"]!.execute({ phrase: "x" }))
      .rejects.toThrow(/no longer has Notes|notes plugin/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("re-reads install state per call, so a snapshot cannot outlive an uninstall", async () => {
    const pluginsRoot = scratchPluginsRoot();
    installFixture(pluginsRoot, "notes", { tools: [echoTool] });
    const invoke = vi.fn().mockResolvedValue("ok");
    const tools = createPluginAgentToolMap({
      listDeclarations: () => listPluginAgentToolDeclarations({ pluginsRoot }),
      invoke,
    });

    expect(await tools!["plugin__notes__echo"]!.execute({ phrase: "x" })).toBe("ok");

    setPluginEnabled(pluginsRoot, "notes", false);

    await expect(tools!["plugin__notes__echo"]!.execute({ phrase: "x" })).rejects.toThrow(/notes/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("the skills budget", () => {
  function writeSkillRoot(pluginRoot: string, files: Record<string, number>): string {
    const skillsRoot = path.join(pluginRoot, "skills");
    for (const [relative, bytes] of Object.entries(files)) {
      const target = path.join(skillsRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "x".repeat(bytes), "utf8");
    }
    return skillsRoot;
  }

  it("keeps a skills root that fits", () => {
    const pluginsRoot = scratchPluginsRoot();
    const pluginRoot = installFixture(pluginsRoot, "notes", { skills: ["skills"] });
    const skillsRoot = writeSkillRoot(pluginRoot, { "note/SKILL.md": 512 });

    expect(listPluginAgentSkillRoots({ pluginsRoot })).toEqual([skillsRoot]);
  });

  it("drops a root that blows the total byte budget, and logs what it dropped", () => {
    const pluginsRoot = scratchPluginsRoot();
    const smallRoot = installFixture(pluginsRoot, "small", { skills: ["skills"] });
    const hugeRoot = installFixture(pluginsRoot, "huge", { skills: ["skills"] });
    const smallSkills = writeSkillRoot(smallRoot, { "a/SKILL.md": 1024 });
    writeSkillRoot(hugeRoot, { "b/SKILL.md": 3 * 1024 * 1024 });
    const logger = { warn: vi.fn() };

    const roots = listPluginAgentSkillRoots({ pluginsRoot, logger });

    // The plugin that fits still gets its skills; only the offender is dropped.
    expect(roots).toEqual([smallSkills]);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin.skill_root_dropped",
      expect.objectContaining({ pluginId: "huge", reason: "total_bytes" }),
    );
  });

  it("drops a root with more files than the walk will look at", () => {
    const pluginsRoot = scratchPluginsRoot();
    const pluginRoot = installFixture(pluginsRoot, "dump", { skills: ["skills"] });
    const files: Record<string, number> = {};
    for (let index = 0; index <= 2_000; index += 1) files[`s/file${index}.md`] = 1;
    writeSkillRoot(pluginRoot, files);
    const logger = { warn: vi.fn() };

    expect(listPluginAgentSkillRoots({ pluginsRoot, logger })).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin.skill_root_dropped",
      expect.objectContaining({ pluginId: "dump", reason: "file_count" }),
    );
  });
});
