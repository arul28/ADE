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
  it("keeps only existing session roots and identifies valid Claude plugin roots", () => {
    const pluginRoot = temporaryRoot();
    const standaloneRoot = temporaryRoot();
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "{}");
    const missingRoot = path.join(pluginRoot, "missing");
    const env = {
      ADE_AGENT_SKILLS_DIRS: [pluginRoot, standaloneRoot, missingRoot].join(path.delimiter),
    };

    expect(existingAgentSkillRoots(env)).toEqual([pluginRoot, standaloneRoot]);
    expect(claudeAgentSkillPluginRoots(env)).toEqual([pluginRoot]);
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
});
