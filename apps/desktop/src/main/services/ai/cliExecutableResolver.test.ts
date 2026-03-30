import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentPathWithKnownCliDirs,
  resolveExecutableFromKnownLocations,
} from "./cliExecutableResolver";

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
}

describe("cliExecutableResolver", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("discovers codex from an npm prefix configured in ~/.npmrc", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-path-"));
    const homeDir = path.join(tempRoot, "home");
    const prefixDir = path.join(homeDir, ".npm-global");
    makeExecutable(path.join(prefixDir, "bin", "codex"));
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".npmrc"), "prefix=~/.npm-global\n", "utf8");

    const env = {
      HOME: homeDir,
      PATH: "/usr/bin:/bin",
    };

    expect(resolveExecutableFromKnownLocations("codex", env)).toEqual({
      path: path.join(prefixDir, "bin", "codex"),
      source: "known-dir",
    });
  });

  it("augments PATH with npm-global bins discovered from ~/.npmrc", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-path-"));
    const homeDir = path.join(tempRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".npmrc"), "prefix=~/.npm-global\n", "utf8");

    const nextPath = augmentPathWithKnownCliDirs("/usr/bin:/bin", {
      HOME: homeDir,
      PATH: "/usr/bin:/bin",
    });

    expect(nextPath.split(path.delimiter)).toContain(path.join(homeDir, ".npm-global", "bin"));
  });

  it("keeps both Intel and Apple Silicon Homebrew bins on PATH", () => {
    const nextPath = augmentPathWithKnownCliDirs("/usr/local/bin:/usr/bin:/bin", {
      HOME: "/tmp/ade-home",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });

    const entries = nextPath.split(path.delimiter);
    expect(entries).toContain("/usr/local/bin");
    expect(entries).toContain("/opt/homebrew/bin");
  });
});
