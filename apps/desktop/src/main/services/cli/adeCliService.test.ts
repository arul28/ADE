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

  it("adds the user install dir to the shell profile when installing Terminal access", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    const packagedCommandPath = path.join(packagedBinDir, "ade");
    const installerPath = path.join(resourcesPath, "ade-cli", "install-path.sh");
    writeExecutable(packagedCommandPath);
    writeExecutable(installerPath);
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      logger: logger() as any,
    });

    const result = await service.installForUser();
    const profilePath = path.join(home, ".zshrc");
    const profile = fs.readFileSync(profilePath, "utf8");

    expect(result.ok).toBe(true);
    expect(result.message).toContain(`added ${path.join(home, ".local", "bin")} to ${profilePath}`);
    expect(profile).toContain("# ADE CLI");
    expect(profile).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("writes to ~/.bashrc when SHELL is bash", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    writeExecutable(path.join(packagedBinDir, "ade"));
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/usr/local/bin/bash", PATH: "/usr/bin:/bin" },
      logger: logger() as any,
    });

    const result = await service.installForUser();
    const profilePath = path.join(home, ".bashrc");

    expect(result.ok).toBe(true);
    expect(result.message).toContain(profilePath);
    expect(fs.readFileSync(profilePath, "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("falls back to ~/.profile when SHELL is unrecognized", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    writeExecutable(path.join(packagedBinDir, "ade"));
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/usr/bin/nu", PATH: "/usr/bin:/bin" },
      logger: logger() as any,
    });

    const result = await service.installForUser();
    const profilePath = path.join(home, ".profile");

    expect(result.ok).toBe(true);
    expect(result.message).toContain(profilePath);
    expect(fs.readFileSync(profilePath, "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("writes fish-syntax PATH update to ~/.config/fish/config.fish for fish shell", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    writeExecutable(path.join(packagedBinDir, "ade"));
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/usr/bin/fish", PATH: "/usr/bin:/bin" },
      logger: logger() as any,
    });

    const result = await service.installForUser();
    const profilePath = path.join(home, ".config", "fish", "config.fish");

    expect(result.ok).toBe(true);
    expect(result.message).toContain(profilePath);
    const profile = fs.readFileSync(profilePath, "utf8");
    expect(profile).toContain("# ADE CLI");
    expect(profile).toContain("fish_add_path -gP $HOME/.local/bin");
    expect(profile).not.toContain("export PATH=");
  });

  it("skips the shell-profile write when the install dir is already on PATH", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    writeExecutable(path.join(packagedBinDir, "ade"));
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");
    const targetDir = path.join(home, ".local", "bin");
    // Simulate an ade binary already at the install location so getStatus
    // reports it as installed once PATH contains targetDir.
    writeExecutable(path.join(targetDir, "ade"));

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/bin/zsh", PATH: `${targetDir}:/usr/bin:/bin` },
      logger: logger() as any,
    });

    const result = await service.installForUser();
    const profilePath = path.join(home, ".zshrc");

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Installed ade for Terminal access.");
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  it("does not append the PATH line twice when the marker is already present", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    writeExecutable(path.join(packagedBinDir, "ade"));
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const profilePath = path.join(home, ".zshrc");
    const seeded = "# previous user content\n\n# ADE CLI\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(profilePath, seeded);

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      logger: logger() as any,
    });

    const result = await service.installForUser();

    expect(result.ok).toBe(true);
    expect(result.message).toContain(profilePath);
    expect(result.message).toContain("PATH entry already present");
    expect(result.message).not.toMatch(/and added .* to /);
    // Profile contents are unchanged — exactly one ADE CLI marker, exactly one PATH line.
    const profile = fs.readFileSync(profilePath, "utf8");
    expect(profile).toBe(seeded);
    expect(profile.match(/# ADE CLI/g)?.length).toBe(1);
  });

  it("inserts a leading newline when the existing profile has no trailing newline", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Resources");
    const packagedBinDir = path.join(resourcesPath, "ade-cli", "bin");
    writeExecutable(path.join(packagedBinDir, "ade"));
    writeExecutable(path.join(resourcesPath, "ade-cli", "install-path.sh"));
    fs.writeFileSync(path.join(resourcesPath, "ade-cli", "cli.cjs"), "console.log('ade')\n");

    const profilePath = path.join(home, ".zshrc");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(profilePath, "alias foo=bar"); // no trailing newline

    const service = createAdeCliService({
      isPackaged: true,
      resourcesPath,
      userDataPath: path.join(root, "user-data"),
      appExecutablePath: path.join(root, "ADE.app", "Contents", "MacOS", "ADE"),
      env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      logger: logger() as any,
    });

    const result = await service.installForUser();
    expect(result.ok).toBe(true);

    const profile = fs.readFileSync(profilePath, "utf8");
    expect(profile.startsWith("alias foo=bar\n")).toBe(true);
    expect(profile).toContain("\n# ADE CLI\n");
    expect(profile).toContain('export PATH="$HOME/.local/bin:$PATH"\n');
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
