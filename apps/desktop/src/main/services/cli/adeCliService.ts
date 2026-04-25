import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdeCliInstallResult, AdeCliStatus } from "../../../shared/types/adeCli";
import type { Logger } from "../logging/logger";
import { spawnAsync } from "../shared/utils";
import {
  getPathEnvKey as findPathEnvKey,
  getPathEnvValue,
  setPathEnvValue,
} from "../ai/cliExecutableResolver";

type CreateAdeCliServiceArgs = {
  isPackaged: boolean;
  resourcesPath: string | null | undefined;
  userDataPath: string;
  appExecutablePath: string;
  env?: NodeJS.ProcessEnv;
  devRepoRoot?: string | null;
  logger: Logger;
};

type ResolvedCliPaths = {
  commandPath: string | null;
  binDir: string | null;
  installerPath: string | null;
  cliJsPath: string | null;
  source: "packaged" | "dev" | "missing";
};

type DevCliEntry = {
  repoRoot: string;
  cliPath: string;
  entryKind: "built" | "source";
};

const PATH_DELIMITER = path.delimiter;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function pathDelimiter(): string {
  return process.platform === "win32" ? ";" : PATH_DELIMITER;
}

function commandFileName(): "ade" | "ade.cmd" {
  return process.platform === "win32" ? "ade.cmd" : "ade";
}

function installerFileName(): "install-path.sh" | "install-path.cmd" {
  return process.platform === "win32" ? "install-path.cmd" : "install-path.sh";
}

function isExecutable(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPathEntries(value: string | null | undefined): string[] {
  return (value ?? "").split(pathDelimiter()).map((entry) => entry.trim()).filter(Boolean);
}

function pathContainsDir(pathValue: string | null | undefined, dir: string | null): boolean {
  if (!dir) return false;
  const resolved = process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  return splitPathEntries(pathValue).some((entry) => {
    try {
      const candidate = process.platform === "win32" ? path.resolve(entry).toLowerCase() : path.resolve(entry);
      return candidate === resolved;
    } catch {
      return false;
    }
  });
}

function prependPathDir(pathValue: string | null | undefined, dir: string | null): string | undefined {
  if (!dir) return pathValue ?? undefined;
  if (pathContainsDir(pathValue, dir)) return pathValue ?? undefined;
  const current = pathValue?.trim();
  return current ? `${dir}${pathDelimiter()}${current}` : dir;
}

function resolveCommandOnPath(command: string, pathValue: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const rawExtensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const extensions = process.platform === "win32"
    ? Array.from(new Set(rawExtensions.flatMap((ext) => [ext, ext.toLowerCase(), ext.toUpperCase()])))
    : rawExtensions;
  const suffixes = process.platform === "win32" && path.extname(command) ? [""] : extensions;
  for (const entry of splitPathEntries(pathValue)) {
    for (const ext of suffixes) {
      const candidate = path.join(entry, `${command}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function escapeCmdSetValue(value: string): string {
  return value.replace(/%/g, "%%").replace(/"/g, "\"\"");
}

function createWindowsShimScript(args: {
  cliJsPath: string;
  entryKind: "built" | "source";
  tsxBinPath: string | null;
  tsxImportPath: string | null;
  appExecutablePath: string;
}): string {
  return [
    "@echo off",
    "setlocal",
    `set "CLI_JS=${escapeCmdSetValue(args.cliJsPath)}"`,
    `set "CLI_ENTRY_KIND=${escapeCmdSetValue(args.entryKind)}"`,
    `set "TSX_BIN=${escapeCmdSetValue(args.tsxBinPath ?? "")}"`,
    `set "TSX_IMPORT=${escapeCmdSetValue(args.tsxImportPath ?? "")}"`,
    `set "APP_EXE=${escapeCmdSetValue(args.appExecutablePath)}"`,
    "if /I \"%CLI_ENTRY_KIND%\"==\"source\" (",
    "  if exist \"%TSX_BIN%\" (",
    "    \"%TSX_BIN%\" \"%CLI_JS%\" %*",
    "    exit /b %ERRORLEVEL%",
    "  )",
    "  if not exist \"%TSX_IMPORT%\" (",
    "    echo ade: Local source CLI fallback requires repo-local tsx. Run npm --prefix apps/ade-cli install or npm --prefix apps/ade-cli run build. 1>&2",
    "    exit /b 127",
    "  )",
    "  if defined ADE_CLI_NODE (",
    "    \"%ADE_CLI_NODE%\" --import \"%TSX_IMPORT%\" \"%CLI_JS%\" %*",
    "    exit /b %ERRORLEVEL%",
    "  )",
    "  if exist \"%APP_EXE%\" (",
    "    set \"ELECTRON_RUN_AS_NODE=1\"",
    "    \"%APP_EXE%\" --import \"%TSX_IMPORT%\" \"%CLI_JS%\" %*",
    "    exit /b %ERRORLEVEL%",
    "  )",
    "  where node >nul 2>nul",
    "  if not errorlevel 1 (",
    "    node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\" >nul 2>nul",
    "    if not errorlevel 1 (",
    "      node --import \"%TSX_IMPORT%\" \"%CLI_JS%\" %*",
    "      exit /b %ERRORLEVEL%",
    "    )",
    "  )",
    "  echo ade: Node.js 22+ or the ADE Electron runtime is required to run this source CLI. 1>&2",
    "  exit /b 127",
    ")",
    "if defined ADE_CLI_NODE (",
    "  \"%ADE_CLI_NODE%\" \"%CLI_JS%\" %*",
    "  exit /b %ERRORLEVEL%",
    ")",
    "if exist \"%APP_EXE%\" (",
    "  set \"ELECTRON_RUN_AS_NODE=1\"",
    "  \"%APP_EXE%\" \"%CLI_JS%\" %*",
    "  exit /b %ERRORLEVEL%",
    ")",
    "where node >nul 2>nul",
    "if not errorlevel 1 (",
    "  node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\" >nul 2>nul",
    "  if not errorlevel 1 (",
    "    node \"%CLI_JS%\" %*",
    "    exit /b %ERRORLEVEL%",
    "  )",
    ")",
    "echo ade: Node.js 22+ or the ADE Electron runtime is required to run this CLI. 1>&2",
    "exit /b 127",
    "",
  ].join("\r\n");
}

function findRepoRoot(startDir: string): string | null {
  let cursor = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(cursor, "apps", "ade-cli", "package.json")) &&
      fs.existsSync(path.join(cursor, "apps", "desktop", "package.json"))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function latestMtimeMs(root: string): number {
  let latest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      latest = Math.max(latest, fs.statSync(fullPath).mtimeMs);
    } catch {
      // Ignore files that disappear during freshness checks.
    }
  }
  return latest;
}

function isBuiltCliFresh(builtCli: string, sourceCli: string): boolean {
  try {
    const builtMtime = fs.statSync(builtCli).mtimeMs;
    const sourceRoot = path.dirname(sourceCli);
    return builtMtime >= latestMtimeMs(sourceRoot);
  } catch {
    return false;
  }
}

function resolveDevCliEntry(devRepoRoot?: string | null): DevCliEntry | null {
  const repoCandidates: string[] = [];
  if (devRepoRoot) repoCandidates.push(path.resolve(devRepoRoot));
  const candidates = [
    process.cwd(),
    typeof __dirname === "string" ? __dirname : null,
    typeof __dirname === "string" ? path.resolve(__dirname, "..", "..", "..", "..") : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const repoRoot = findRepoRoot(candidate);
    if (!repoRoot) continue;
    repoCandidates.push(repoRoot);
  }
  for (const repoRoot of [...new Set(repoCandidates)]) {
    const builtCli = path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
    const sourceCli = path.join(repoRoot, "apps", "ade-cli", "src", "cli.ts");
    if (fs.existsSync(sourceCli) && (!fs.existsSync(builtCli) || !isBuiltCliFresh(builtCli, sourceCli))) {
      return {
        repoRoot,
        cliPath: sourceCli,
        entryKind: "source",
      };
    }
    if (fs.existsSync(builtCli)) {
      return {
        repoRoot,
        cliPath: builtCli,
        entryKind: "built",
      };
    }
    if (fs.existsSync(sourceCli)) {
      return {
        repoRoot,
        cliPath: sourceCli,
        entryKind: "source",
      };
    }
  }
  return null;
}

function writeDevShim(args: {
  cliJsPath: string;
  entryKind: "built" | "source";
  tsxBinPath: string | null;
  tsxImportPath: string | null;
  userDataPath: string;
  appExecutablePath: string;
  logger: Logger;
}): { commandPath: string; binDir: string } | null {
  const binDir = path.join(args.userDataPath, "ade-cli", "bin");
  const commandPath = path.join(binDir, commandFileName());
  const script = process.platform === "win32" ? createWindowsShimScript(args) : [
    "#!/bin/sh",
    "set -eu",
    `CLI_JS=${shellQuote(args.cliJsPath)}`,
    `CLI_ENTRY_KIND=${shellQuote(args.entryKind)}`,
    `TSX_BIN=${shellQuote(args.tsxBinPath ?? "")}`,
    `TSX_IMPORT=${shellQuote(args.tsxImportPath ?? "")}`,
    `APP_EXE=${shellQuote(args.appExecutablePath)}`,
    "if [ \"$CLI_ENTRY_KIND\" = \"source\" ]; then",
    "  if [ -x \"$TSX_BIN\" ]; then",
    "    exec \"$TSX_BIN\" \"$CLI_JS\" \"$@\"",
    "  fi",
    "  if [ ! -f \"$TSX_IMPORT\" ]; then",
    "    echo \"ade: Local source CLI fallback requires repo-local tsx. Run npm --prefix apps/ade-cli install or npm --prefix apps/ade-cli run build.\" >&2",
    "    exit 127",
    "  fi",
    "  if [ -n \"${ADE_CLI_NODE:-}\" ]; then",
    "    exec \"$ADE_CLI_NODE\" --import \"$TSX_IMPORT\" \"$CLI_JS\" \"$@\"",
    "  fi",
    "  if [ -x \"$APP_EXE\" ]; then",
    "    ELECTRON_RUN_AS_NODE=1 exec \"$APP_EXE\" --import \"$TSX_IMPORT\" \"$CLI_JS\" \"$@\"",
    "  fi",
    "  if command -v node >/dev/null 2>&1; then",
    "    NODE_MAJOR=$(node -p \"Number(process.versions.node.split('.')[0])\" 2>/dev/null || echo 0)",
    "    if [ \"$NODE_MAJOR\" -ge 22 ]; then",
    "      exec node --import \"$TSX_IMPORT\" \"$CLI_JS\" \"$@\"",
    "    fi",
    "  fi",
    "  if command -v asdf >/dev/null 2>&1; then",
    "    exec asdf exec node --import \"$TSX_IMPORT\" \"$CLI_JS\" \"$@\"",
    "  fi",
    "  echo \"ade: Node.js 22+ or the ADE Electron runtime is required to run this source CLI.\" >&2",
    "  exit 127",
    "fi",
    "if [ -n \"${ADE_CLI_NODE:-}\" ]; then",
    "  exec \"$ADE_CLI_NODE\" \"$CLI_JS\" \"$@\"",
    "fi",
    "if [ -x \"$APP_EXE\" ]; then",
    "  ELECTRON_RUN_AS_NODE=1 exec \"$APP_EXE\" \"$CLI_JS\" \"$@\"",
    "fi",
    "if command -v node >/dev/null 2>&1; then",
    "  NODE_MAJOR=$(node -p \"Number(process.versions.node.split('.')[0])\" 2>/dev/null || echo 0)",
    "  if [ \"$NODE_MAJOR\" -ge 22 ]; then",
    "    exec node \"$CLI_JS\" \"$@\"",
    "  fi",
    "fi",
    "if command -v asdf >/dev/null 2>&1; then",
    "  exec asdf exec node \"$CLI_JS\" \"$@\"",
    "fi",
    "echo \"ade: Node.js 22+ or the ADE Electron runtime is required to run this CLI.\" >&2",
    "exit 127",
    "",
  ].join("\n");

  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(commandPath, script, process.platform === "win32"
      ? { encoding: "utf8" }
      : { encoding: "utf8", mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(commandPath, 0o755);
    return { commandPath, binDir };
  } catch (error) {
    args.logger.warn("ade_cli.dev_shim_failed", {
      path: commandPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveCliPaths(args: CreateAdeCliServiceArgs): ResolvedCliPaths {
  const resourcesPath = args.resourcesPath ? path.resolve(args.resourcesPath) : null;
  const packagedBinDir = resourcesPath ? path.join(resourcesPath, "ade-cli", "bin") : null;
  const packagedCommandPath = packagedBinDir ? path.join(packagedBinDir, commandFileName()) : null;
  const packagedCliJsPath = resourcesPath ? path.join(resourcesPath, "ade-cli", "cli.cjs") : null;
  const packagedInstallerPath = resourcesPath ? path.join(resourcesPath, "ade-cli", installerFileName()) : null;

  if (args.isPackaged && isExecutable(packagedCommandPath)) {
    return {
      commandPath: packagedCommandPath,
      binDir: packagedBinDir,
      installerPath: isExecutable(packagedInstallerPath) ? packagedInstallerPath : null,
      cliJsPath: fs.existsSync(packagedCliJsPath ?? "") ? packagedCliJsPath : null,
      source: "packaged",
    };
  }

  const devCli = resolveDevCliEntry(args.devRepoRoot);
  if (devCli) {
    const shim = writeDevShim({
      cliJsPath: devCli.cliPath,
      entryKind: devCli.entryKind,
      tsxBinPath: path.join(devCli.repoRoot, "apps", "ade-cli", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
      tsxImportPath: path.join(devCli.repoRoot, "apps", "ade-cli", "node_modules", "tsx", "dist", "loader.mjs"),
      userDataPath: args.userDataPath,
      appExecutablePath: args.appExecutablePath,
      logger: args.logger,
    });
    if (shim) {
      return {
        commandPath: shim.commandPath,
        binDir: shim.binDir,
        installerPath: null,
        cliJsPath: devCli.cliPath,
        source: "dev",
      };
    }
  }

  return {
    commandPath: null,
    binDir: null,
    installerPath: null,
    cliJsPath: null,
    source: "missing",
  };
}

function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || os.homedir();
}

function installTargetPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir(env), "AppData", "Local");
    return path.join(localAppData, "ADE", "bin", "ade.cmd");
  }
  return path.join(homeDir(env), ".local", "bin", "ade");
}

function shellProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const shell = env.SHELL?.trim() ?? "";
  const home = homeDir(env);
  if (shell.endsWith("zsh")) return path.join(home, ".zshrc");
  if (shell.endsWith("bash")) return path.join(home, ".bashrc");
  return path.join(home, ".profile");
}

function shellPathEntry(targetDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = homeDir(env);
  const relativeToHome = path.relative(home, targetDir);
  if (relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return `$HOME/${relativeToHome.split(path.sep).join("/")}`;
  }
  return targetDir;
}

function ensureUserBinOnShellPath(targetDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === "win32" || pathContainsDir(getPathEnvValue(env), targetDir)) return null;
  const profilePath = shellProfilePath(env);
  const entry = shellPathEntry(targetDir, env);
  const marker = "# ADE CLI";
  const line = `export PATH="${entry}:$PATH"`;
  const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "";
  if (existing.includes(marker) || existing.includes(line) || existing.includes(targetDir)) {
    return profilePath;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.appendFileSync(profilePath, `${prefix}\n${marker}\n${line}\n`);
  return profilePath;
}

function statusMessage(args: {
  terminalInstalled: boolean;
  bundledAvailable: boolean;
  agentPathReady: boolean;
  installAvailable: boolean;
  isPackaged: boolean;
}): { message: string; nextAction: string | null } {
  if (args.terminalInstalled && args.agentPathReady) {
    return {
      message: "The ade command is available to Terminal and ADE-launched agents.",
      nextAction: null,
    };
  }
  if (args.agentPathReady && args.bundledAvailable) {
    return {
      message: "ADE-launched agents can use ade. Terminal access is not installed yet.",
      nextAction: args.installAvailable
        ? "Install the ade command for Terminal access."
        : "Run npm link in apps/ade-cli for local development.",
    };
  }
  if (args.bundledAvailable) {
    return {
      message: "The bundled ade command is present, but it is not on the agent PATH yet.",
      nextAction: "Restart ADE so new agent sessions receive the bundled CLI path.",
    };
  }
  return {
    message: args.isPackaged
      ? "The bundled ade command is missing from this app build."
      : "The local ADE CLI build was not found.",
    nextAction: args.isPackaged
      ? "Reinstall or update ADE."
      : "Run npm --prefix apps/ade-cli run build.",
  };
}

export function createAdeCliService(args: CreateAdeCliServiceArgs) {
  const resolved = resolveCliPaths(args);
  const envSnapshot = args.env ?? process.env;
  const hostPathSnapshot = getPathEnvValue(envSnapshot);

  const agentEnv = (baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = { ...baseEnv };
    const nextPath = prependPathDir(getPathEnvValue(next), resolved.binDir);
    if (nextPath) setPathEnvValue(next, nextPath);
    if (resolved.commandPath) next.ADE_CLI_PATH = resolved.commandPath;
    if (resolved.binDir) next.ADE_CLI_BIN_DIR = resolved.binDir;
    return next;
  };

  const applyToProcessEnv = (): void => {
    const next = agentEnv(process.env);
    const nextPath = getPathEnvValue(next);
    if (nextPath) setPathEnvValue(process.env, nextPath);
    if (next.ADE_CLI_PATH) process.env.ADE_CLI_PATH = next.ADE_CLI_PATH;
    if (next.ADE_CLI_BIN_DIR) process.env.ADE_CLI_BIN_DIR = next.ADE_CLI_BIN_DIR;
  };

  const getStatus = async (): Promise<AdeCliStatus> => {
    const terminalCommandPath = resolveCommandOnPath("ade", hostPathSnapshot, envSnapshot);
    const targetPath = installTargetPath(envSnapshot);
    const targetDir = path.dirname(targetPath);
    const terminalInstalled = Boolean(terminalCommandPath);
    const bundledAvailable = Boolean(resolved.commandPath && isExecutable(resolved.commandPath));
    const hostPathEnv: NodeJS.ProcessEnv = {};
    if (hostPathSnapshot) setPathEnvValue(hostPathEnv, hostPathSnapshot);
    const agentPathReady = bundledAvailable && pathContainsDir(getPathEnvValue(agentEnv(hostPathEnv)), resolved.binDir);
    const installAvailable = resolved.source === "packaged" && isExecutable(resolved.installerPath);
    const message = statusMessage({
      terminalInstalled,
      bundledAvailable,
      agentPathReady,
      installAvailable,
      isPackaged: args.isPackaged,
    });

    return {
      command: "ade",
      platform: process.platform,
      isPackaged: args.isPackaged,
      bundledAvailable,
      bundledBinDir: resolved.binDir,
      bundledCommandPath: resolved.commandPath,
      installerPath: resolved.installerPath,
      agentPathReady,
      terminalInstalled,
      terminalCommandPath,
      installAvailable,
      installTargetPath: targetPath,
      installTargetDirOnPath: pathContainsDir(hostPathSnapshot, targetDir),
      message: message.message,
      nextAction: message.nextAction,
    };
  };

  const installForUser = async (): Promise<AdeCliInstallResult> => {
    if (!isExecutable(resolved.installerPath)) {
      const status = await getStatus();
      return {
        ok: false,
        message: args.isPackaged
          ? "The ADE CLI installer is missing from this app build."
          : "Terminal install is available from packaged ADE builds. For local development, run npm link in apps/ade-cli.",
        status,
      };
    }

    try {
      const result = await spawnAsync(resolved.installerPath!, []);
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "ADE CLI installer failed.");
      }
      const targetDir = path.dirname(installTargetPath(envSnapshot));
      const profilePath = ensureUserBinOnShellPath(targetDir, envSnapshot);
      const status = await getStatus();
      return {
        ok: true,
        message: profilePath
          ? `Installed ade for Terminal access and added ${targetDir} to ${profilePath}. Open a new terminal or source that file.`
          : status.installTargetDirOnPath
          ? "Installed ade for Terminal access."
          : `Installed ade at ${status.installTargetPath}. Add ${path.dirname(status.installTargetPath)} to PATH if your shell cannot find it.`,
        status,
      };
    } catch (error) {
      args.logger.warn("ade_cli.install_failed", {
        installerPath: resolved.installerPath,
        error: error instanceof Error ? error.message : String(error),
      });
      const status = await getStatus();
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        status,
      };
    }
  };

  return {
    getStatus,
    installForUser,
    agentEnv,
    applyToProcessEnv,
    resolved,
  };
}
