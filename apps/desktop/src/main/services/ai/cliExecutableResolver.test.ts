import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  augmentPathWithKnownCliDirs,
  augmentProcessPathWithShellAndKnownCliDirs,
  getPathEnvValue,
  resolveExecutableFromKnownLocations,
  setPathEnvValue,
} from "./cliExecutableResolver";

const originalPlatform = process.platform;
const originalPathDelimiter = path.delimiter;

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

function setPathDelimiter(value: string): void {
  Object.defineProperty(path, "delimiter", {
    value,
    configurable: true,
  });
}

function currentPathDelimiter(): string {
  return process.platform === "win32" ? ";" : path.delimiter;
}

describe("cliExecutableResolver", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
    setPathDelimiter(originalPathDelimiter);
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

    expect(nextPath.split(currentPathDelimiter())).toContain(path.join(homeDir, ".npm-global", "bin"));
  });

  it("keeps both Intel and Apple Silicon Homebrew bins on PATH", () => {
    const nextPath = augmentPathWithKnownCliDirs("/usr/local/bin:/usr/bin:/bin", {
      HOME: "/tmp/ade-home",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });

    const entries = nextPath.split(currentPathDelimiter());
    expect(entries).toContain("/usr/local/bin");
    expect(entries).toContain("/opt/homebrew/bin");
  });

  it("augments PATH with known CLI dirs on Windows", () => {
    setPlatform("win32");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-path-"));
    const homeDir = path.join(tempRoot, "home");
    const scoopShims = path.join(homeDir, "scoop", "shims");
    fs.mkdirSync(scoopShims, { recursive: true });
    const fakeCodex = path.join(scoopShims, "codex.cmd");
    fs.writeFileSync(fakeCodex, "@echo off\r\n", "utf8");

    const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
      env: {
        USERPROFILE: homeDir,
        HOME: homeDir,
        PATH: "C:\\Windows\\System32",
      },
    });

    expect(nextPath.split(currentPathDelimiter())).toContain(scoopShims);
  });

  it("reads and updates Windows Path without creating duplicate PATH keys", () => {
    setPlatform("win32");
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Windows\\System32",
    };

    expect(getPathEnvValue(env)).toBe("C:\\Windows\\System32");
    setPathEnvValue(env, "C:\\Tools;C:\\Windows\\System32");

    expect(env.Path).toBe("C:\\Tools;C:\\Windows\\System32");
    expect(env.PATH).toBeUndefined();
  });

  it("prefers USERPROFILE over a Git Bash-style HOME for Windows known dirs", () => {
    setPlatform("win32");
    setPathDelimiter(";");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-path-"));
    const gitBashHome = "/c/Users/Alice";
    const userProfile = "C:\\Users\\Alice";
    const scoopShims = path.join(userProfile, "scoop", "shims");
    const voltaBin = path.join(userProfile, ".volta", "bin");
    const opencodeBin = path.join(userProfile, ".opencode", "bin");
    const realExecutable = path.join(tempRoot, "codex.CMD");
    makeExecutable(realExecutable);

    const realStatSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((candidatePath: fs.PathLike, opts?: any) => {
      const normalizedCandidate = path.normalize(String(candidatePath));
      if (normalizedCandidate.toLowerCase() === path.normalize(path.join(scoopShims, "codex.CMD")).toLowerCase()) {
        return realStatSync(realExecutable, opts);
      }
      const err: NodeJS.ErrnoException = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }) as typeof fs.statSync);

    const nextPath = augmentPathWithKnownCliDirs("C:\\Windows\\System32", {
      HOME: gitBashHome,
      USERPROFILE: userProfile,
      PATH: "C:\\Windows\\System32",
    });

    expect(nextPath).toContain(scoopShims);
    expect(nextPath).toContain(voltaBin);
    expect(nextPath).toContain(opencodeBin);
    expect(nextPath).not.toContain(path.join(gitBashHome, "scoop", "shims"));
    expect(nextPath).not.toContain(path.join(gitBashHome, ".volta", "bin"));
    expect(nextPath).not.toContain(path.join(gitBashHome, ".opencode", "bin"));

    expect(resolveExecutableFromKnownLocations("codex", {
      HOME: gitBashHome,
      USERPROFILE: userProfile,
      PATH: "C:\\Windows\\System32",
    })).toEqual({
      path: path.join(scoopShims, "codex.CMD"),
      source: "known-dir",
    });
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

  it("resolves Windows executables from Path when PATH is absent", () => {
    setPlatform("win32");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-path-"));
    const binDir = path.join(tempRoot, "bin");
    const executablePath = path.join(binDir, "codex.cmd");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(executablePath, "@echo off\r\n", "utf8");

    const resolved = resolveExecutableFromKnownLocations("codex", {
      Path: binDir,
      PATHEXT: ".CMD;.EXE",
    });
    expect(resolved?.source).toBe("path");
    expect(resolved?.path.toLowerCase()).toBe(executablePath.toLowerCase());
  });
});
