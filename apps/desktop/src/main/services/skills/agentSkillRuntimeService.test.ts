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
  withoutAgentSkills,
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
});

describe("withholding skills from a root", () => {
  function skillRoot(): string {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), "{}");
    for (const name of ["ade-browser", "ade-lanes-git", "ade-pr-workflows"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "SKILL.md"), `# ${name}`);
    }
    return root;
  }

  it("serves a private mirror under the ADE home without the withheld skills, and leaves clean roots alone", () => {
    const adeHome = temporaryRoot();
    const previousHome = process.env.ADE_HOME;
    process.env.ADE_HOME = adeHome;
    try {
      const root = skillRoot();
      const clean = temporaryRoot();
      fs.mkdirSync(path.join(clean, "ade-browser"));

      const [mirror, untouched] = withoutAgentSkills([root, clean], ["ade-lanes-git", "ade-pr-workflows"]);

      // Never the shared temp dir: a mirror is loaded as a Claude plugin.
      expect(path.dirname(mirror!)).toBe(path.join(adeHome, "agent-skill-shims", "filtered"));
      expect(fs.readdirSync(mirror!).sort()).toEqual([".claude-plugin", "ade-browser"]);
      expect(fs.existsSync(path.join(mirror!, ".claude-plugin", "plugin.json"))).toBe(true);
      expect(untouched).toBe(clean);
      // The source root is never edited.
      expect(fs.existsSync(path.join(root, "ade-lanes-git", "SKILL.md"))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousHome;
    }
  });

  it("refuses a mirror parent that is a link to somewhere else, and serves the root unfiltered", () => {
    const root = skillRoot();
    const elsewhere = temporaryRoot();
    const holder = temporaryRoot();
    const parent = path.join(holder, "filtered");
    // A junction on Windows (no privilege needed), a directory symlink elsewhere.
    fs.symlinkSync(elsewhere, parent, "junction");

    expect(withoutAgentSkills([root], ["ade-lanes-git"], parent)).toEqual([root]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a mirror parent another user owns", () => {
    const root = skillRoot();
    const parent = path.join(temporaryRoot(), "filtered");
    fs.mkdirSync(parent);
    // The owner check is POSIX's (Windows has no owner uid here), so run it as
    // POSIX would, with the directory owned by someone other than us.
    const ownerUid = fs.statSync(parent).uid;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    Object.defineProperty(process, "getuid", { configurable: true, writable: true, value: () => ownerUid + 1 });
    try {
      expect(withoutAgentSkills([root], ["ade-pr-workflows"], parent)).toEqual([root]);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (getuid) Object.defineProperty(process, "getuid", getuid);
      else delete (process as { getuid?: unknown }).getuid;
    }
  });
});
