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
});
