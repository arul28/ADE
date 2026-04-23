import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdeCliService } from "./adeCliService";

const tmpRoots: string[] = [];
const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-service-"));
  tmpRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, content = "#!/bin/sh\nexit 0\n"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("createAdeCliService", () => {
  it("uses packaged ade-cli/bin when the bundled wrapper exists", () => {
    const root = makeTempRoot();
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    const packagedCommandPath = path.join(packagedBinDir, "ade");
    writeExecutable(packagedCommandPath);
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      logger: logger() as any,
    });

    expect(service.resolved).toEqual({
      source: "packaged",
      binDir: packagedBinDir,
      commandPath: packagedCommandPath,
      installerPath: path.join(resourcesPath, "ade-cli", "install-path.sh"),
      cliJsPath: path.join(resourcesPath, "ade-cli", "cli.cjs"),
    });
    expect(service.agentEnv({ PATH: "/usr/bin:/bin" }).PATH?.split(path.delimiter)[0]).toBe(packagedBinDir);
  });

  it("uses packaged Windows cmd wrappers and Path casing", async () => {
    setPlatform("win32");
    const root = makeTempRoot();
    process.env.LOCALAPPDATA = path.join(root, "LocalAppData");
    const resourcesPath = path.join(root, "resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    const packagedCommandPath = path.join(packagedBinDir, "ade.cmd");
    writeExecutable(packagedCommandPath, "@echo off\r\nexit /b 0\r\n");
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.cmd"), "@echo off\r\nexit /b 0\r\n");
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.exe"),
      env: {
        Path: `${packagedBinDir};C:\\Windows\\System32`,
        PATHEXT: ".EXE;.CMD",
      },
      logger: logger() as any,
    });

    expect(service.resolved).toEqual({
      source: "packaged",
      binDir: packagedBinDir,
      commandPath: packagedCommandPath,
      installerPath: path.join(resourcesPath, "ade-cli", "install-path.cmd"),
      cliJsPath: path.join(resourcesPath, "ade-cli", "cli.cjs"),
    });
    expect(service.agentEnv({ Path: "C:\\Windows\\System32" }).Path?.split(";")[0]).toBe(packagedBinDir);
    expect(service.agentEnv({ Path: "C:\\Windows\\System32" }).PATH).toBeUndefined();

    const status = await service.getStatus();
    expect(status.terminalInstalled).toBe(true);
    expect(status.terminalCommandPath?.toLowerCase()).toBe(packagedCommandPath.toLowerCase());
    expect(status.installTargetPath.endsWith(path.join("ADE", "bin", "ade.cmd"))).toBe(true);
  });

  it("reports Terminal install status from the original host PATH after agent PATH is applied", async () => {
    const root = makeTempRoot();
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    const packagedCommandPath = path.join(packagedBinDir, "ade");
    writeExecutable(packagedCommandPath);
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const previousPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const service = createAdeCliService({
        isPackaged: true,
        resourcesPath,
        userDataPath: path.join(root, "user-data"),
        appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
        env: { PATH: "/usr/bin:/bin" },
        logger: logger() as any,
      });

      service.applyToProcessEnv();
      expect(process.env.PATH?.split(path.delimiter)[0]).toBe(packagedBinDir);

      const status = await service.getStatus();
      expect(status.agentPathReady).toBe(true);
      expect(status.terminalInstalled).toBe(false);
      expect(status.terminalCommandPath).toBeNull();
      expect(status.nextAction).toBe("Install the ade command for Terminal access.");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("reports agent readiness from the ADE agent environment before global PATH is mutated", async () => {
    const root = makeTempRoot();
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    const packagedCommandPath = path.join(packagedBinDir, "ade");
    writeExecutable(packagedCommandPath);
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const previousPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const service = createAdeCliService({
        isPackaged: true,
        resourcesPath,
        userDataPath: path.join(root, "user-data"),
        appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
        env: { PATH: "/usr/bin:/bin" },
        logger: logger() as any,
      });

      const status = await service.getStatus();
      expect(process.env.PATH).toBe("/usr/bin:/bin");
      expect(status.agentPathReady).toBe(true);
      expect(status.terminalInstalled).toBe(false);
      expect(status.nextAction).toBe("Install the ade command for Terminal access.");
      expect(service.agentEnv({ PATH: "/usr/bin:/bin" }).PATH?.split(path.delimiter)[0]).toBe(packagedBinDir);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("creates a dev shim under userData without changing global PATH", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const userDataPath = path.join(root, "user-data");
    const cliJsPath = path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
    fs.mkdirSync(path.dirname(cliJsPath), { recursive: true });
    fs.writeFileSync(cliJsPath, "console.log('ade')\n");
    fs.mkdirSync(path.join(repoRoot, "apps", "desktop"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps", "ade-cli", "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "{}\n");
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

    const service = createAdeCliService({
      isPackaged: false,
      resourcesPath: path.join(root, "missing-resources"),
      userDataPath,
      appExecutablePath: "/Applications/ADE.app/Contents/MacOS/ADE",
      logger: logger() as any,
    });

    const shimPath = path.join(userDataPath, "ade-cli", "bin", "ade");
    expect(service.resolved.source).toBe("dev");
    expect(service.resolved.commandPath).toBe(shimPath);
    expect(fs.existsSync(shimPath)).toBe(true);
    expect(fs.readFileSync(shimPath, "utf8")).toContain("ELECTRON_RUN_AS_NODE=1 exec \"$APP_EXE\" \"$CLI_JS\" \"$@\"");
    expect(service.agentEnv({ PATH: "/usr/bin:/bin" }).PATH?.split(path.delimiter)[0]).toBe(path.dirname(shimPath));
  });

  it("creates a Windows dev cmd shim under userData", () => {
    setPlatform("win32");
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const userDataPath = path.join(root, "user-data");
    const cliJsPath = path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
    fs.mkdirSync(path.dirname(cliJsPath), { recursive: true });
    fs.writeFileSync(cliJsPath, "console.log('ade')\n");
    fs.mkdirSync(path.join(repoRoot, "apps", "desktop"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps", "ade-cli", "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "{}\n");
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

    const service = createAdeCliService({
      isPackaged: false,
      resourcesPath: path.join(root, "missing-resources"),
      userDataPath,
      appExecutablePath: path.join(root, "ADE.exe"),
      logger: logger() as any,
    });

    const shimPath = path.join(userDataPath, "ade-cli", "bin", "ade.cmd");
    const script = fs.readFileSync(shimPath, "utf8");

    expect(service.resolved.source).toBe("dev");
    expect(service.resolved.commandPath).toBe(shimPath);
    expect(script).toContain("@echo off");
    expect(script).toContain("set \"APP_EXE=");
    expect(script).toContain("\"%APP_EXE%\" \"%CLI_JS%\" %*");
    expect(script).toContain(path.join("node_modules", ".bin", "tsx.cmd"));
    expect(service.agentEnv({ Path: "C:\\Windows\\System32" }).Path?.split(";")[0]).toBe(path.dirname(shimPath));
  });

  it("falls back to source CLI when dist/cli.cjs is missing in a dev repo", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const userDataPath = path.join(root, "user-data");
    const sourceCliPath = path.join(repoRoot, "apps", "ade-cli", "src", "cli.ts");
    fs.mkdirSync(path.dirname(sourceCliPath), { recursive: true });
    fs.writeFileSync(sourceCliPath, "console.log('ade source')\n");
    fs.mkdirSync(path.join(repoRoot, "apps", "desktop"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps", "ade-cli", "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "{}\n");
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

    const service = createAdeCliService({
      isPackaged: false,
      resourcesPath: path.join(root, "missing-resources"),
      userDataPath,
      appExecutablePath: "/Applications/ADE.app/Contents/MacOS/ADE",
      logger: logger() as any,
    });

    const shimPath = path.join(userDataPath, "ade-cli", "bin", "ade");
    const shimScript = fs.readFileSync(shimPath, "utf8");

    expect(service.resolved.source).toBe("dev");
    expect(service.resolved.cliJsPath).toBe(sourceCliPath);
    expect(shimScript).toContain("CLI_ENTRY_KIND='source'");
    expect(shimScript).toContain("exec \"$TSX_BIN\" \"$CLI_JS\" \"$@\"");
    expect(shimScript).toContain("TSX_IMPORT=");
    expect(shimScript).toContain("--import \"$TSX_IMPORT\" \"$CLI_JS\" \"$@\"");
    expect(shimScript).not.toContain("exec tsx \"$CLI_JS\" \"$@\"");
    expect(shimScript).not.toContain("--import tsx \"$CLI_JS\" \"$@\"");
  });

  it("uses source CLI when the dev dist artifact is older than source", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const userDataPath = path.join(root, "user-data");
    const builtCliPath = path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
    const sourceCliPath = path.join(repoRoot, "apps", "ade-cli", "src", "cli.ts");
    fs.mkdirSync(path.dirname(builtCliPath), { recursive: true });
    fs.mkdirSync(path.dirname(sourceCliPath), { recursive: true });
    fs.writeFileSync(builtCliPath, "console.log('old dist')\n");
    fs.writeFileSync(sourceCliPath, "console.log('new source')\n");
    fs.mkdirSync(path.join(repoRoot, "apps", "desktop"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "apps", "ade-cli", "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "{}\n");
    const oldTime = new Date("2026-04-20T00:00:00.000Z");
    const newTime = new Date("2026-04-21T00:00:00.000Z");
    fs.utimesSync(builtCliPath, oldTime, oldTime);
    fs.utimesSync(sourceCliPath, newTime, newTime);
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

    const service = createAdeCliService({
      isPackaged: false,
      resourcesPath: path.join(root, "missing-resources"),
      userDataPath,
      appExecutablePath: "/Applications/ADE.app/Contents/MacOS/ADE",
      logger: logger() as any,
    });

    expect(service.resolved.source).toBe("dev");
    expect(service.resolved.cliJsPath).toBe(sourceCliPath);
  });

  it("does not run a global installer from dev builds", async () => {
    const root = makeTempRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);

    const service = createAdeCliService({
      isPackaged: false,
      resourcesPath: path.join(root, "missing-resources"),
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: "/Applications/ADE.app/Contents/MacOS/ADE",
      logger: logger() as any,
    });

    const result = await service.installForUser();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("local development");
  });
});
