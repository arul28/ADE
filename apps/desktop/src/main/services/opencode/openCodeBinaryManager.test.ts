import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOpenCodeBinaryCache,
  resolveOpenCodeBinary,
} from "./openCodeBinaryManager";

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  SHELL: process.env.SHELL,
};

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

describe("openCodeBinaryManager", () => {
  let tempRoot: string;
  let homeDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-bin-"));
    homeDir = path.join(tempRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
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
    clearOpenCodeBinaryCache();
    vi.restoreAllMocks();
    process.env.HOME = originalEnv.HOME;
    process.env.PATH = originalEnv.PATH;
    process.env.SHELL = originalEnv.SHELL;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("rechecks after a missing result so a newly installed OpenCode binary is discovered", () => {
    expect(resolveOpenCodeBinary()).toEqual({ path: null, source: "missing" });

    const binaryPath = path.join(homeDir, ".npm-global", "bin", "opencode");
    makeExecutable(binaryPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: binaryPath,
      source: "user-installed",
    });
  });

  it("invalidates a cached positive path if the binary disappears", () => {
    const binaryPath = path.join(homeDir, ".npm-global", "bin", "opencode");
    makeExecutable(binaryPath);

    expect(resolveOpenCodeBinary()).toEqual({
      path: binaryPath,
      source: "user-installed",
    });

    fs.rmSync(binaryPath);

    expect(resolveOpenCodeBinary()).toEqual({ path: null, source: "missing" });
  });
});
