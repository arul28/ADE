import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeSettingsLocalPath,
  discoverClaudePlugins,
  discoverClaudeOutputStyles,
  readClaudeOutputStyleSelection,
  resolveClaudeOutputStyle,
  writeClaudeOutputStyleSelection,
} from "./claudeOutputStyles";

let tmpRoot: string;
let homeRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-output-styles-test-"));
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-output-styles-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
});

afterEach(() => {
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
