import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeSettingsLocalPath,
  discoverClaudePlugins,
  discoverClaudeOutputStyles,
  readClaudeOutputStyleSelection,
  readClaudeWorkflowSizeGuideline,
  resolveClaudeOutputStyle,
  writeClaudeOutputStyleSelection,
} from "./claudeOutputStyles";

let tmpRoot: string;
let homeRoot: string;
let previousClaudeConfigDir: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-output-styles-test-"));
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-output-styles-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
  // The shared test setup points CLAUDE_CONFIG_DIR at its own temp dir, which now
  // wins over homedir(). Aim it at this test's home so the user tier is the one
  // these cases write to, and so no case can read the developer's real ~/.claude.
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(homeRoot, ".claude");
});

afterEach(() => {
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

describe("discoverClaudeOutputStyles", () => {
  it("includes built-ins and discovers project/user markdown styles", () => {
    const projectDir = path.join(tmpRoot, ".claude", "output-styles");
    const userDir = path.join(homeRoot, ".claude", "output-styles");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "reviewer.md"), [
      "---",
      "name: Reviewer",
      "description: Review-first responses",
      "---",
      "",
      "Focus on review.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(userDir, "mentor.md"), [
      "---",
      "name: Mentor",
      "---",
      "",
      "Explain the work.",
      "",
    ].join("\n"));

    expect(discoverClaudeOutputStyles(tmpRoot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Default", source: "builtin" }),
      expect.objectContaining({ name: "Reviewer", source: "project", description: "Review-first responses" }),
      expect.objectContaining({ name: "Mentor", source: "user" }),
    ]));
  });

  it("discovers plugin output styles from local Claude plugin roots", () => {
    const pluginRoot = path.join(tmpRoot, ".claude", "plugins", "team-tools", "style-plugin");
    const styleDir = path.join(pluginRoot, "output-styles");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(styleDir, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "style-plugin" }));
    fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: { "style-plugin@local": true },
    }));
    fs.writeFileSync(path.join(styleDir, "brief.md"), [
      "---",
      "name: Brief",
      "description: Short answers",
      "---",
      "",
      "Keep it brief.",
      "",
    ].join("\n"));

    expect(discoverClaudeOutputStyles(tmpRoot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Brief", source: "plugin", pluginPath: fs.realpathSync(pluginRoot) }),
    ]));
  });

  it("resolves styles case-insensitively and persists selection in settings.local.json", () => {
    expect(resolveClaudeOutputStyle(tmpRoot, "learning")?.name).toBe("Learning");

    const settingsPath = writeClaudeOutputStyleSelection(tmpRoot, "Learning");
    expect(settingsPath).toBe(claudeSettingsLocalPath(tmpRoot));
    expect(readClaudeOutputStyleSelection(tmpRoot)).toBe("Learning");
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      outputStyle: "Learning",
    });
  });
});

describe("discoverClaudePlugins", () => {
  it("reads local plugin manifests from Claude plugin roots", () => {
    const pluginRoot = path.join(tmpRoot, ".claude", "plugins", "team-tools", "review-plugin");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "review-plugin",
      description: "Review helpers",
      version: "1.2.3",
    }));
    fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: { "review-plugin@local": true },
    }));

    expect(discoverClaudePlugins(tmpRoot)).toEqual([
      {
        name: "review-plugin",
        description: "Review helpers",
        version: "1.2.3",
        path: fs.realpathSync(pluginRoot),
        source: "local",
      },
    ]);
  });

  it("ignores plugins that are only present in the user marketplace cache", () => {
    const pluginRoot = path.join(
      homeRoot,
      ".claude",
      "plugins",
      "marketplaces",
      "claude-plugins-official",
      "external_plugins",
      "serena",
    );
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "serena",
      description: "Marketplace source copy",
    }));

    expect(discoverClaudePlugins(tmpRoot)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "serena" }),
    ]));
  });

  it("loads manually placed user plugins outside managed Claude plugin dirs", () => {
    const pluginRoot = path.join(homeRoot, ".claude", "plugins", "personal-review-plugin");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "personal-review-plugin",
      description: "Local user helper",
    }));

    expect(discoverClaudePlugins(tmpRoot)).toEqual([
      {
        name: "personal-review-plugin",
        description: "Local user helper",
        path: fs.realpathSync(pluginRoot),
        source: "local",
      },
    ]);
  });

  it("loads installed user plugins only when Claude settings enable them", () => {
    const enabledRoot = path.join(
      homeRoot,
      ".claude",
      "plugins",
      "cache",
      "claude-plugins-official",
      "code-simplifier",
      "1.0.0",
    );
    const disabledRoot = path.join(
      homeRoot,
      ".claude",
      "plugins",
      "cache",
      "claude-plugins-official",
      "serena",
      "1.0.0",
    );
    fs.mkdirSync(path.join(enabledRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(disabledRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(enabledRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "code-simplifier",
    }));
    fs.writeFileSync(path.join(disabledRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "serena",
    }));
    fs.writeFileSync(path.join(homeRoot, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: {
        "code-simplifier@claude-plugins-official": true,
        "serena@claude-plugins-official": false,
      },
    }));
    fs.writeFileSync(path.join(homeRoot, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "code-simplifier@claude-plugins-official": [
          { scope: "user", installPath: enabledRoot },
        ],
        "serena@claude-plugins-official": [
          { scope: "user", installPath: disabledRoot },
        ],
      },
    }));

    expect(discoverClaudePlugins(tmpRoot)).toEqual([
      {
        name: "code-simplifier",
        path: fs.realpathSync(enabledRoot),
        source: "local",
      },
    ]);
  });

  it("does not load disabled plugins just because they exist in the user plugin tree", () => {
    const enabledRoot = path.join(homeRoot, ".claude", "plugins", "cache", "claude-plugins-official", "review-pack", "1.0.0");
    const disabledRoot = path.join(homeRoot, ".claude", "plugins", "marketplaces", "claude-plugins-official", "external_plugins", "serena");
    fs.mkdirSync(path.join(enabledRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(disabledRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(enabledRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "review-pack" }));
    fs.writeFileSync(path.join(disabledRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "serena" }));
    fs.writeFileSync(path.join(homeRoot, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: {
        "review-pack@claude-plugins-official": true,
        "serena@claude-plugins-official": false,
      },
    }));
    fs.writeFileSync(path.join(homeRoot, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "review-pack@claude-plugins-official": [
          { scope: "user", installPath: enabledRoot, version: "1.0.0" },
        ],
        "serena@claude-plugins-official": [
          { scope: "user", installPath: disabledRoot, version: "1.0.0" },
        ],
      },
    }));

    expect(discoverClaudePlugins(tmpRoot).map((plugin) => plugin.name)).toEqual(["review-pack"]);
  });
});

describe("settings precedence", () => {
  const writeSettings = (root: string, fileName: string, value: Record<string, unknown>): void => {
    const dir = path.join(root, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(value, null, 2));
  };

  it("returns null rather than \"Default\" when no settings file names a style", () => {
    // "Default" is a real style that suppresses a globally configured one. ADE
    // passes its settings at flag tier, so a substituted default would silently
    // override the user's ~/.claude selection in every lane.
    expect(readClaudeOutputStyleSelection(tmpRoot)).toBeNull();
  });

  it("falls back to the user's ~/.claude selection when the lane declares none", () => {
    writeSettings(homeRoot, "settings.json", { outputStyle: "ASD-STE100" });
    expect(readClaudeOutputStyleSelection(tmpRoot)).toBe("ASD-STE100");
  });

  it("prefers lane settings.local.json over lane settings.json over the user file", () => {
    writeSettings(homeRoot, "settings.json", { outputStyle: "UserStyle" });
    writeSettings(tmpRoot, "settings.json", { outputStyle: "ProjectStyle" });
    expect(readClaudeOutputStyleSelection(tmpRoot)).toBe("ProjectStyle");

    writeSettings(tmpRoot, "settings.local.json", { outputStyle: "LaneStyle" });
    expect(readClaudeOutputStyleSelection(tmpRoot)).toBe("LaneStyle");
  });

  it("reads workflowSizeGuideline through the same ladder", () => {
    expect(readClaudeWorkflowSizeGuideline(tmpRoot)).toBeNull();
    writeSettings(homeRoot, "settings.json", { workflowSizeGuideline: "large" });
    expect(readClaudeWorkflowSizeGuideline(tmpRoot)).toBe("large");
  });
});

describe("CLAUDE_CONFIG_DIR vs the ancestor walk", () => {
  it("does not let a stale real ~/.claude outrank the relocated config dir", () => {
    // The regression: a lane normally sits UNDER $HOME, so the ancestor walk
    // reaches ~/.claude and ranked it as a project tier above the user tier.
    // With CLAUDE_CONFIG_DIR pointing elsewhere the stale home settings won,
    // and ADE then passed that at flag tier — overriding the very directory the
    // CLI reads. The other tests cannot catch this: their cwd is a SIBLING of
    // the fake home, so the walk never reaches it.
    const laneRoot = path.join(homeRoot, "proj", "lane");
    fs.mkdirSync(path.join(laneRoot, ".claude"), { recursive: true });

    const relocated = path.join(homeRoot, "relocated-claude");
    fs.mkdirSync(relocated, { recursive: true });
    fs.writeFileSync(path.join(relocated, "settings.json"), JSON.stringify({ outputStyle: "RelocatedStyle" }));

    fs.mkdirSync(path.join(homeRoot, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(homeRoot, ".claude", "settings.json"),
      JSON.stringify({ outputStyle: "StaleHomeStyle" }),
    );

    process.env.CLAUDE_CONFIG_DIR = relocated;
    expect(readClaudeOutputStyleSelection(laneRoot)).toBe("RelocatedStyle");
  });

  it("still reads the real home when no override is set", () => {
    const laneRoot = path.join(homeRoot, "proj", "lane");
    fs.mkdirSync(laneRoot, { recursive: true });
    fs.mkdirSync(path.join(homeRoot, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(homeRoot, ".claude", "settings.json"),
      JSON.stringify({ outputStyle: "HomeStyle" }),
    );

    delete process.env.CLAUDE_CONFIG_DIR;
    expect(readClaudeOutputStyleSelection(laneRoot)).toBe("HomeStyle");
  });
});
