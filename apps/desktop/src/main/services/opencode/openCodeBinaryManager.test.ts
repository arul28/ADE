import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMockState = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));
const cacheLookupMockState = vi.hoisted(() => ({
  cachedToolEntryPath: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => childProcessMockState.execFileSync(...args),
  };
});

vi.mock("../../../../../ade-cli/src/services/tools/cacheLookup", () => ({
  cachedToolEntryPath: (..._args: unknown[]) => cacheLookupMockState.cachedToolEntryPath(),
}));

import {
  clearOpenCodeBinaryCache,
  probeOpenCodeBinaryQuarantine,
  resolveOpenCodeBinary,
} from "./openCodeBinaryManager";

const originalEnv = {
  ADE_DISABLE_BUNDLED_OPENCODE: process.env.ADE_DISABLE_BUNDLED_OPENCODE,
  ADE_OPENCODE_BUNDLE_ROOT: process.env.ADE_OPENCODE_BUNDLE_ROOT,
  HOME: process.env.HOME,
  NODE_PATH: process.env.NODE_PATH,
  PATH: process.env.PATH,
  SHELL: process.env.SHELL,
};
const originalProcessPlatform = process.platform;
const originalProcessArch = process.arch;

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function setProcessArch(arch: NodeJS.Architecture): void {
  Object.defineProperty(process, "arch", {
    value: arch,
    configurable: true,
  });
}

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
}

function enoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("ENOENT");
  error.code = "ENOENT";
  return error;
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("openCodeBinaryManager", () => {
  let tempRoot: string;
  let homeDir: string;

  beforeEach(() => {
    childProcessMockState.execFileSync.mockReset();
    cacheLookupMockState.cachedToolEntryPath.mockReset();
    cacheLookupMockState.cachedToolEntryPath.mockReturnValue(null);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-bin-"));
    homeDir = path.join(tempRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    delete process.env.ADE_DISABLE_BUNDLED_OPENCODE;
    delete process.env.ADE_OPENCODE_BUNDLE_ROOT;
    delete process.env.NODE_PATH;
    process.env.PATH = "/usr/bin:/bin";
    process.env.SHELL = "/bin/false";
    clearOpenCodeBinaryCache();

    const realStatSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((candidatePath: fs.PathLike, opts?: any) => {
      const normalized = path.normalize(String(candidatePath));
      const normalizedRoot = path.normalize(tempRoot);
      if (path.basename(normalized) === "opencode" && !normalized.startsWith(normalizedRoot)) {
        throw enoent();
      }
      return realStatSync(normalized, opts);
    }) as typeof fs.statSync);
  });

  afterEach(() => {
    setProcessPlatform(originalProcessPlatform);
    setProcessArch(originalProcessArch);
    clearOpenCodeBinaryCache();
    vi.restoreAllMocks();
    restoreEnv("ADE_DISABLE_BUNDLED_OPENCODE");
    restoreEnv("ADE_OPENCODE_BUNDLE_ROOT");
    restoreEnv("HOME");
    restoreEnv("NODE_PATH");
    restoreEnv("PATH");
    restoreEnv("SHELL");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("rechecks after a missing result so a newly installed OpenCode binary is discovered", () => {
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    expect(resolveOpenCodeBinary()).toEqual({ path: null, source: "missing" });

    const binaryPath = path.join(homeDir, ".npm-global", "bin", "opencode");
    makeExecutable(binaryPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: binaryPath,
      source: "user-installed",
    });
  });

  it("invalidates a cached positive path if the binary disappears", () => {
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    const binaryPath = path.join(homeDir, ".npm-global", "bin", "opencode");
    makeExecutable(binaryPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: binaryPath,
      source: "user-installed",
    });

    fs.rmSync(binaryPath);

    expect(resolveOpenCodeBinary()).toEqual({ path: null, source: "missing" });
  });

  it("prefers ADE's bundled OpenCode runtime over a user-installed binary", () => {
    process.env.ADE_OPENCODE_BUNDLE_ROOT = tempRoot;
    const bundledPath = path.join(tempRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
    const userPath = path.join(homeDir, ".npm-global", "bin", "opencode");
    makeExecutable(bundledPath);
    makeExecutable(userPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: bundledPath,
      source: "bundled",
    });
  });

  it("keeps an explicit bundle root ahead of the tools cache and user install", () => {
    process.env.ADE_OPENCODE_BUNDLE_ROOT = tempRoot;
    const bundledPath = path.join(tempRoot, "node_modules", "opencode-ai", "bin", "opencode");
    const cachedPath = path.join(tempRoot, "cache", "opencode");
    const userPath = path.join(homeDir, ".npm-global", "bin", "opencode");
    makeExecutable(bundledPath);
    makeExecutable(cachedPath);
    makeExecutable(userPath);
    cacheLookupMockState.cachedToolEntryPath.mockReturnValue(cachedPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: bundledPath,
      source: "bundled",
    });

    fs.rmSync(bundledPath);
    clearOpenCodeBinaryCache();
    expect(resolveOpenCodeBinary()).toEqual({ path: null, source: "missing" });
  });

  it("resolves the packaged Windows x64 layout to the baseline package", () => {
    // Mirrors what afterPack materializes for win32: the `-baseline` native
    // package plus an `opencode-ai` shell whose bin/ has been pruned. The AVX2
    // `opencode-windows-x64` package is deliberately absent from the installer.
    setProcessPlatform("win32");
    setProcessArch("x64");
    process.env.ADE_OPENCODE_BUNDLE_ROOT = tempRoot;
    const baselinePath = path.join(
      tempRoot, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe",
    );
    makeExecutable(baselinePath);
    fs.mkdirSync(path.join(tempRoot, "node_modules", "opencode-ai", "bin"), { recursive: true });

    expect(resolveOpenCodeBinary()).toEqual({ path: baselinePath, source: "bundled" });
  });

  it("does not resolve the AVX2 opencode-windows-x64 package on win32 x64", () => {
    // Guards the packaging saving: nothing in the resolver's candidate list names
    // the AVX2 package, so any copy of it in the installer is unreachable weight.
    setProcessPlatform("win32");
    process.env.ADE_OPENCODE_BUNDLE_ROOT = tempRoot;
    const avx2Path = path.join(tempRoot, "node_modules", "opencode-windows-x64", "bin", "opencode.exe");
    makeExecutable(avx2Path);
    fs.mkdirSync(path.join(tempRoot, "node_modules", "opencode-ai", "bin"), { recursive: true });

    expect(resolveOpenCodeBinary().path).not.toBe(avx2Path);
  });

  it("finds the bundled OpenCode runtime from NODE_PATH for static ADE runtimes", () => {
    const runtimeNodeModules = path.join(tempRoot, "ade-darwin-arm64.native", "node_modules");
    process.env.NODE_PATH = runtimeNodeModules;
    const bundledPath = path.join(runtimeNodeModules, "opencode-ai", "bin", "opencode.exe");
    makeExecutable(bundledPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: bundledPath,
      source: "bundled",
    });
  });

  it("treats any successful quarantine attribute read as quarantined", () => {
    setProcessPlatform("darwin");
    childProcessMockState.execFileSync.mockReturnValue("");

    expect(probeOpenCodeBinaryQuarantine("/bin/opencode")).toBe("quarantined");
  });

  it("returns clean only for an explicit missing quarantine attribute", () => {
    setProcessPlatform("darwin");
    childProcessMockState.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("xattr failed"), {
        status: 1,
        stderr: "xattr: /bin/opencode: No such xattr: com.apple.quarantine",
      });
    });

    expect(probeOpenCodeBinaryQuarantine("/bin/opencode")).toBe("clean");
  });

  it("keeps other quarantine probe failures unknown", () => {
    setProcessPlatform("darwin");
    childProcessMockState.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("xattr failed"), {
        status: 1,
        stderr: "xattr: /bin/opencode: Permission denied",
      });
    });

    expect(probeOpenCodeBinaryQuarantine("/bin/opencode")).toBe("unknown");
  });
});
