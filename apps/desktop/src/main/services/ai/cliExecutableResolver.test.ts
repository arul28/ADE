import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  augmentPathWithKnownCliDirs,
  resolveExecutableFromKnownLocations,
} from "./cliExecutableResolver";

const originalPlatform = process.platform;

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

describe("cliExecutableResolver", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
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

    // Hide system-installed codex so it doesn't win the known-dirs race.
    const realStatSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, opts?: any) => {
      const normalizedCandidate = path.normalize(String(p));
      const normalizedTempRoot = path.normalize(tempRoot!);
      const candidateBase = path.parse(normalizedCandidate).name.toLowerCase();
      if (candidateBase === "codex" && !normalizedCandidate.startsWith(normalizedTempRoot)) {
        const err: NodeJS.ErrnoException = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return realStatSync(normalizedCandidate, opts);
    }) as typeof fs.statSync);

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

  it("resolves Windows executables using PATHEXT suffixes", () => {
    setPlatform("win32");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-path-"));
    const binDir = path.join(tempRoot, "bin");
    const executablePath = path.join(binDir, "codex.CMD");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(executablePath, "@echo off\r\n", "utf8");

    const env = {
      PATH: binDir,
      PATHEXT: ".EXE;.CMD;.BAT",
    };

    expect(resolveExecutableFromKnownLocations("codex", env)).toEqual({
      path: executablePath,
      source: "path",
    });
  });
});
