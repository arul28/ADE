/**
 * The "Show in Finder" allowlist of a provider page's Initial context window.
 *
 * It is a security boundary: the renderer names a path, and the main process
 * may only show it when it is a provider's setup, the project, or an
 * instruction file above the project. The roots and the resolver are the two
 * halves the IPC handler composes, so the test composes them the same way, on
 * a real folder tree.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWithinAllowedDirs } from "../ipc/allowedRendererPath";
import { providerContextRevealRoots, resolveProviderContextRevealTarget } from "./providerContextReveal";

let tempRoot: string;
let home: string;
let project: string;

function write(file: string, text = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function roots(): string[] {
  return providerContextRevealRoots({
    projectRoot: project,
    adeDir: path.join(home, ".ade"),
    appDirs: [],
    env: {},
    homeDir: home,
  });
}

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-context-reveal-")));
  home = path.join(tempRoot, "home");
  project = path.join(home, "Projects", "app");
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("providerContextRevealRoots", () => {
  it.each([
    ["the user's CLAUDE.md", () => write(path.join(home, ".claude", "CLAUDE.md"))],
    ["Claude's MCP file beside its config folder", () => write(path.join(home, ".claude.json"))],
    ["Codex's config", () => write(path.join(home, ".codex", "config.toml"))],
    ["a shared skill", () => write(path.join(home, ".agents", "skills", "lint", "SKILL.md"))],
    ["a file in the project", () => write(path.join(project, "AGENTS.md"))],
    ["a CLAUDE.md in a folder above the project", () => write(path.join(home, "Projects", "CLAUDE.md"))],
  ])("allows %s", (_label, make) => {
    const file = make();
    expect(resolveWithinAllowedDirs(roots(), file)).toBe(file);
  });

  it.each([
    ["an SSH key", () => write(path.join(home, ".ssh", "id_ed25519"))],
    ["any other file in a folder above the project", () => write(path.join(home, "Projects", "notes.txt"))],
    ["a path that climbs out of an allowed folder", () => {
      write(path.join(home, ".ssh", "id_ed25519"));
      return path.join(home, ".claude", "..", ".ssh", "id_ed25519");
    }],
  ])("refuses %s", (_label, make) => {
    const file = make();
    expect(() => resolveWithinAllowedDirs(roots(), file)).toThrow(/outside allowed directories/);
  });

  it("refuses a link inside an allowed folder whose target is outside every root", () => {
    const secret = write(path.join(home, ".ssh", "id_ed25519"));
    const link = path.join(home, ".claude", "skills", "leak");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(secret, link);
    expect(fs.realpathSync(link)).toBe(secret);
    expect(() => resolveWithinAllowedDirs(roots(), link)).toThrow(/outside allowed directories/);
  });
});

describe("resolveProviderContextRevealTarget", () => {
  it("shows a skill link where the provider sees it, even when its target is outside every root", () => {
    const dotfiles = write(path.join(tempRoot, "dotfiles", "lint", "SKILL.md"));
    const link = path.join(home, ".claude", "skills", "lint");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.dirname(dotfiles), link);
    expect(() => resolveWithinAllowedDirs(roots(), link)).toThrow(/outside allowed directories/);
    expect(resolveProviderContextRevealTarget(roots(), link)).toBe(link);
  });

  it("refuses a path that passes through a symlinked folder", () => {
    write(path.join(home, ".ssh", "id_ed25519"));
    const linkedDir = path.join(project, "keys");
    fs.symlinkSync(path.join(home, ".ssh"), linkedDir);
    const through = path.join(linkedDir, "id_ed25519");
    expect(fs.realpathSync(through)).toBe(path.join(home, ".ssh", "id_ed25519"));
    expect(() => resolveProviderContextRevealTarget(roots(), through)).toThrow(/outside allowed directories/);
    expect(() => resolveProviderContextRevealTarget(roots(), "relative/path")).toThrow(/outside allowed directories/);
  });
});
