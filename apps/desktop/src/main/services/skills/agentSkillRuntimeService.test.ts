import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADE_AGENT_SKILLS_DIRS_ENV } from "../../../shared/agentSkillRoots";
import {
  adePromptAgentSkillRoots,
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

describe("prompt-facing skill roots", () => {
  it("drops advertised roots that are not on disk", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-root-"));
    try {
      const roots = adePromptAgentSkillRoots({
        cwd: "/nonexistent-lane-worktree",
        processCwd: null,
        env: { [ADE_AGENT_SKILLS_DIRS_ENV]: real },
        dirname: null,
      } as never);

      expect(roots).toEqual([real]);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("keeps every Node-side prompt caller on the disk-filtered helper", () => {
    // The shared helper cannot stat, so a main-process or CLI file that imports
    // it directly advertises roots that may not exist. Three callers did; this
    // is the guard that stops a fourth.
    // `src/main` and the ADE CLI only. `src/shared` is bundled into the
    // renderer, which has no filesystem, so its default-argument fallbacks to
    // the unfiltered helper are correct and deliberate.
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
    const searchRoots = [
      path.join(repoRoot, "apps", "desktop", "src", "main"),
      path.join(repoRoot, "apps", "ade-cli", "src"),
    ].filter((root) => fs.existsSync(root));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (full.endsWith(path.join("skills", "agentSkillRuntimeService.ts"))) continue;
        if (fs.readFileSync(full, "utf8").includes("getAdeAgentSkillRootsForPrompt")) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    for (const root of searchRoots) walk(root);

    expect(offenders).toEqual([]);
  });
});
