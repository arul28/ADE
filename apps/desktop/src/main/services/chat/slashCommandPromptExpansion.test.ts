import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderSlashCommandPrompt } from "./slashCommandPromptExpansion";

/**
 * Contract for `resolveProviderSlashCommandPrompt`: a leading `/<name>` is
 * expanded from ADE's own roots for every provider, the chat's own harness
 * commands are left alone, and each provider's harness-specific root is still
 * consulted. Uses a unique probe name so a bundled skill cannot satisfy the
 * "no source" case.
 */
const PROBE = "adeproviderprobe";
const created: string[] = [];

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-slash-expansion-"));
  created.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, body: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NO_HARNESS_COMMANDS = new Set<string>();

describe("resolveProviderSlashCommandPrompt", () => {
  it.each([
    { provider: "claude" as const, source: ".claude/skills" },
    { provider: "codex" as const, source: ".codex/prompts" },
    { provider: "cursor" as const, source: ".cursor/commands" },
    { provider: "opencode" as const, source: ".claude/skills" },
    { provider: "droid" as const, source: ".agents/skills" },
  ])("expands ADE's own command for $provider from $source", ({ provider, source }) => {
    const cwd = makeProject();
    const isSkill = source.endsWith("/skills");
    writeFile(
      cwd,
      isSkill ? `${source}/${PROBE}/SKILL.md` : `${source}/${PROBE}.md`,
      `ADE probe body.\n\nTask: $ARGUMENTS\n`,
    );
    const prompt = resolveProviderSlashCommandPrompt({
      provider,
      cwd,
      trimmedInput: `/${PROBE} run it`,
      slashCommand: `/${PROBE}`,
      harnessCommandNames: NO_HARNESS_COMMANDS,
    });
    expect(prompt).toContain("ADE probe body.");
    expect(prompt).toContain("run it");
  });

  it("leaves a harness command to the harness for every provider", () => {
    for (const provider of ["claude", "codex", "cursor", "opencode", "droid", "pi"] as const) {
      const cwd = makeProject();
      writeFile(cwd, `.claude/skills/${PROBE}/SKILL.md`, "ADE probe body.");
      expect(resolveProviderSlashCommandPrompt({
        provider,
        cwd,
        trimmedInput: `/${PROBE} now`,
        slashCommand: `/${PROBE}`,
        harnessCommandNames: new Set([`/${PROBE}`]),
      })).toBeNull();
    }
  });

  it("returns null when no ADE or harness root provides the name", () => {
    const cwd = makeProject();
    expect(resolveProviderSlashCommandPrompt({
      provider: "opencode",
      cwd,
      trimmedInput: `/${PROBE} hello`,
      slashCommand: `/${PROBE}`,
      harnessCommandNames: NO_HARNESS_COMMANDS,
    })).toBeNull();
  });

  it("lets Cursor's own .cursor/commands win over a same-named ADE skill", () => {
    const cwd = makeProject();
    writeFile(cwd, `.claude/skills/${PROBE}/SKILL.md`, "ADE probe body.");
    writeFile(cwd, `.cursor/commands/${PROBE}.md`, "Cursor probe body.");
    const prompt = resolveProviderSlashCommandPrompt({
      provider: "cursor",
      cwd,
      trimmedInput: `/${PROBE} x`,
      slashCommand: `/${PROBE}`,
      harnessCommandNames: NO_HARNESS_COMMANDS,
    });
    expect(prompt).toContain("Cursor probe body.");
  });
});
