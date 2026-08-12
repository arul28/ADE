import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSkillSlashCommands,
  claudeAgentSkillPluginRoots,
  codexSkillsForCwd,
  codexSkillsListParams,
  existingAgentSkillRoots,
} from "./agentSkillRuntimeService";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-skills-"));
  temporaryRoots.push(root);
  return root;
}

describe("agentSkillRuntimeService", () => {
  it("keeps only existing session roots and loads only the trusted Claude plugin root", () => {
    const pluginRoot = temporaryRoot();
    const repositoryRoot = temporaryRoot();
    const standaloneRoot = temporaryRoot();
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "{}");
    fs.mkdirSync(path.join(repositoryRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, ".claude-plugin", "plugin.json"), "{}");
    const missingRoot = path.join(pluginRoot, "missing");
    const env = {
      ADE_AGENT_SKILLS_DIRS: [repositoryRoot, pluginRoot, standaloneRoot, missingRoot].join(path.delimiter),
      ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
    };

    expect(existingAgentSkillRoots(env)).toEqual([repositoryRoot, pluginRoot, standaloneRoot]);
    expect(claudeAgentSkillPluginRoots(env)).toEqual([fs.realpathSync(pluginRoot)]);
  });

  it("fails closed when only an untrusted repository plugin manifest is present", () => {
    const repositoryRoot = temporaryRoot();
    fs.mkdirSync(path.join(repositoryRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, ".claude-plugin", "plugin.json"), "{}");

    expect(claudeAgentSkillPluginRoots({
      ADE_AGENT_SKILLS_DIRS: repositoryRoot,
    })).toEqual([]);
  });

  it("canonicalizes trusted roots and rejects symlink escapes from the catalog", () => {
    const pluginRoot = temporaryRoot();
    const catalogParent = temporaryRoot();
    const pluginAlias = path.join(catalogParent, "bundle-alias");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "{}");
    fs.symlinkSync(pluginRoot, pluginAlias, "dir");

    expect(claudeAgentSkillPluginRoots({
      ADE_AGENT_SKILLS_DIRS: pluginAlias,
      ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
    })).toEqual([fs.realpathSync(pluginRoot)]);

    expect(claudeAgentSkillPluginRoots({
      ADE_AGENT_SKILLS_DIRS: catalogParent,
      ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
    })).toEqual([]);
  });

  it("loads an installed plugin's skills root beside the bundled one", () => {
    const bundledRoot = temporaryRoot();
    const pluginSkillsRoot = temporaryRoot();
    for (const root of [bundledRoot, pluginSkillsRoot]) {
      fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), "{}");
    }
    const env = {
      ADE_AGENT_SKILLS_DIRS: [bundledRoot, pluginSkillsRoot].join(path.delimiter),
      ADE_BUNDLED_AGENT_SKILLS_DIR: bundledRoot,
    };

    // Claude never reads ADE_AGENT_SKILLS_DIRS, so a plugin-owned skill reaches
    // it only as a plugin root. The bundled root stays first.
    expect(claudeAgentSkillPluginRoots(env, { pluginSkillRoots: [pluginSkillsRoot] }))
      .toEqual([fs.realpathSync(bundledRoot), fs.realpathSync(pluginSkillsRoot)]);

    // The same directory, with no plugin installed that claims it, is refused:
    // a marker file alone is not a reason to hand Claude hooks and commands.
    expect(claudeAgentSkillPluginRoots(env, { pluginSkillRoots: [] }))
      .toEqual([fs.realpathSync(bundledRoot)]);
  });

  it("drops a plugin root that is not part of this session's catalog", () => {
    const bundledRoot = temporaryRoot();
    const disabledPluginRoot = temporaryRoot();
    for (const root of [bundledRoot, disabledPluginRoot]) {
      fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), "{}");
    }

    // The launcher writes only enabled plugins' roots into the env, so a root
    // missing from it never belonged to this session.
    expect(claudeAgentSkillPluginRoots({
      ADE_AGENT_SKILLS_DIRS: bundledRoot,
      ADE_BUNDLED_AGENT_SKILLS_DIR: bundledRoot,
    }, { pluginSkillRoots: [disabledPluginRoot] })).toEqual([fs.realpathSync(bundledRoot)]);
  });

  it("ignores a plugin skills root with no Claude plugin marker", () => {
    const bundledRoot = temporaryRoot();
    const unmarkedRoot = temporaryRoot();
    fs.mkdirSync(path.join(bundledRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(bundledRoot, ".claude-plugin", "plugin.json"), "{}");

    expect(claudeAgentSkillPluginRoots({
      ADE_AGENT_SKILLS_DIRS: [bundledRoot, unmarkedRoot].join(path.delimiter),
      ADE_BUNDLED_AGENT_SKILLS_DIR: bundledRoot,
    }, { pluginSkillRoots: [unmarkedRoot] })).toEqual([fs.realpathSync(bundledRoot)]);
  });

  it("builds cwd-scoped Codex discovery params without persisting roots", () => {
    expect(codexSkillsListParams("/repo", ["/bundle"])).toEqual({
      cwds: ["/repo"],
      forceReload: true,
      perCwdExtraUserRoots: [{ cwd: "/repo", extraUserRoots: ["/bundle"] }],
    });
    expect(codexSkillsListParams("/repo", [])).toEqual({
      cwds: ["/repo"],
      forceReload: true,
    });
  });

  it("normalizes both current and legacy Codex skill-list response shapes", () => {
    const current = codexSkillsForCwd({
      data: [
        { cwd: "/other", skills: [{ name: "other" }] },
        { cwd: "/repo", skills: [{ name: "ade-browser", description: "Browser" }] },
      ],
    }, "/repo");
    const legacy = codexSkillsForCwd({ skills: [{ name: "ade-search" }] }, "/repo");

    expect(agentSkillSlashCommands(current)).toEqual([
      { name: "/ade-browser", description: "Browser" },
    ]);
    expect(agentSkillSlashCommands(legacy)).toEqual([
      { name: "/ade-search", description: "" },
    ]);
  });

  it("does not borrow Codex skills from another lane", () => {
    expect(codexSkillsForCwd({
      data: [
        { cwd: "/lane-a", skills: [{ name: "lane-a-skill" }] },
        { cwd: "/lane-b", skills: [{ name: "lane-b-skill" }] },
      ],
    }, "/lane-c")).toEqual([]);

    expect(codexSkillsForCwd({
      data: [{ skills: [{ name: "legacy-single-cwd" }] }],
    }, "/lane-c")).toEqual([{ name: "legacy-single-cwd" }]);
  });
});
