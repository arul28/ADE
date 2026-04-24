import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverCodexSlashCommands, resolveCodexSlashCommandInvocation } from "./codexSlashCommandDiscovery";

let tmpRoot: string;
let homeRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-prompts-test-"));
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-home-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

describe("discoverCodexSlashCommands", () => {
  it("discovers user Codex prompt files as slash commands", () => {
    const promptsDir = path.join(homeRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "finalize.md"), "Finalize the current work.\n\nRun checks.");

    expect(discoverCodexSlashCommands(tmpRoot)).toEqual([
      {
        name: "/finalize",
        description: "Finalize the current work.",
      },
    ]);
  });

  it("lets project prompt files override same-named user prompt files", () => {
    fs.mkdirSync(path.join(homeRoot, ".codex", "prompts"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".codex", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, ".codex", "prompts", "audit.md"), "User audit.");
    fs.writeFileSync(path.join(tmpRoot, ".codex", "prompts", "audit.md"), "Project audit.");

    expect(discoverCodexSlashCommands(tmpRoot)).toEqual([
      {
        name: "/audit",
        description: "Project audit.",
      },
    ]);
  });
});

describe("resolveCodexSlashCommandInvocation", () => {
  it("expands Codex prompt files and substitutes $ARGUMENTS", () => {
    const promptsDir = path.join(homeRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "audit.md"), "Audit the work.\n\nFocus: $ARGUMENTS");

    expect(resolveCodexSlashCommandInvocation(tmpRoot, "/audit chat menu")).toEqual({
      name: "/audit",
      argumentsText: "chat menu",
      promptText: "Audit the work.\n\nFocus: chat menu",
    });
  });

  it("appends arguments when the prompt file has no placeholder", () => {
    const promptsDir = path.join(homeRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "trace.md"), "Trace recent changes.");

    expect(resolveCodexSlashCommandInvocation(tmpRoot, "/trace command routing")?.promptText).toBe(
      "Trace recent changes.\n\ncommand routing",
    );
  });

  it("returns null for built-in or unknown commands", () => {
    expect(resolveCodexSlashCommandInvocation(tmpRoot, "/help")).toBeNull();
    expect(resolveCodexSlashCommandInvocation(tmpRoot, "/missing")).toBeNull();
  });
});
