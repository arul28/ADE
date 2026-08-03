import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ResolutionSource = "path" | "known-dir";
const PATH_MARKER_START = "__ADE_PATH_START__";
const PATH_MARKER_END = "__ADE_PATH_END__";

export type ResolvedExecutable = {
  path: string;
  source: ResolutionSource;
};

function* executableCandidatesFromKnownLocations(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Generator<ResolvedExecutable> {
  const seen = new Set<string>();
  const nextCandidate = (
    candidatePath: string | null,
    source: ResolutionSource,
  ): ResolvedExecutable | null => {
    if (!candidatePath || seen.has(candidatePath)) return null;
    seen.add(candidatePath);
    return { path: candidatePath, source };
  };

  for (const dir of splitPathEntries(getPathEnvValue(env))) {
    const candidate = nextCandidate(resolveFromDirs(command, [dir], env), "path");
    if (candidate) yield candidate;
  }
  for (const dir of getKnownBinDirs(command, env)) {
    const candidate = nextCandidate(resolveFromDirs(command, [dir], env), "known-dir");
    if (candidate) yield candidate;
  }
}

export function resolveExecutableCandidatesFromKnownLocations(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutable[] {
  return [...executableCandidatesFromKnownLocations(command, env)];
}

function getHomeDir(env: NodeJS.ProcessEnv): string {
  const profile = env.USERPROFILE?.trim();
  if (process.platform === "win32") {
    if (profile && profile.length > 0) return profile;
    const home = env.HOME?.trim();
    if (home && home.length > 0) return home;
    return os.homedir();
  }
  const home = env.HOME?.trim();
  if (home && home.length > 0) return home;
  return os.homedir();
}

function uniqueNonEmpty(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    out.add(trimmed);
  }
  return [...out];
}

function pathListDelimiter(): string {
  return process.platform === "win32" ? ";" : path.delimiter;
}

export function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  // If multiple case-variants exist (e.g. both `PATH` and `Path` because
  // callers mutated `process.env.PATH` directly while Windows originally
  // set `Path`), prefer the canonical uppercase key so readers do not pick
  // up a stale inherited value.
  const keys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  if (keys.length === 0) return "Path";
  if (keys.includes("PATH")) return "PATH";
  return keys[0]!;
}

export function getPathEnvValue(env: NodeJS.ProcessEnv): string | undefined {
  return env[getPathEnvKey(env)];
}

export function setPathEnvValue(env: NodeJS.ProcessEnv, value: string): void {
  const key = getPathEnvKey(env);
  if (process.platform === "win32") {
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === "path" && existing !== key) {
        delete env[existing];
      }
    }
  }
  env[key] = value;
}

function expandHomePath(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2));
  return input;
}

function parseNpmPrefix(line: string, homeDir: string): string | null {
  const match = line.match(/^\s*prefix\s*=\s*(.+?)\s*$/);
  if (!match) return null;
  const raw = match[1].trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return null;
  return expandHomePath(raw, homeDir);
}

function readNpmPrefixBinDirs(env: NodeJS.ProcessEnv): string[] {
  const homeDir = getHomeDir(env);
  const rcPaths = [
    path.join(homeDir, ".npmrc"),
    path.join(homeDir, ".config", "npm", "npmrc"),
  ];
  const prefixes = new Set<string>();

  for (const rcPath of rcPaths) {
    try {
      const raw = fs.readFileSync(rcPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const prefix = parseNpmPrefix(line, homeDir);
        if (prefix) prefixes.add(prefix);
      }
    } catch {
      // Ignore unreadable npmrc files.
    }
  }

  return uniqueNonEmpty(
    [...prefixes].flatMap((prefix) =>
      process.platform === "win32"
        ? [prefix, path.join(prefix, "bin")]
        : [path.join(prefix, "bin")],
    ),
  );
}

function getWindowsKnownBinDirs(env: NodeJS.ProcessEnv, command: string): string[] {
  const homeDir = getHomeDir(env);
  const localAppData = env.LOCALAPPDATA?.trim();
  const appData = env.APPDATA?.trim();
  const programFiles = env.ProgramFiles?.trim();
  const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
  const programData = env.ProgramData?.trim();
  const scoop = env.SCOOP?.trim();
  const bunInstall = env.BUN_INSTALL?.trim();
  const voltaHome = env.VOLTA_HOME?.trim();
  const pnpmHome = env.PNPM_HOME?.trim();
  const asdfDataDir = env.ASDF_DATA_DIR?.trim();

  return uniqueNonEmpty([
    // `npm i -g` writes `<cmd>.cmd` / `<cmd>.ps1` shims straight into %APPDATA%\npm.
    appData ? path.join(appData, "npm") : "",
    // Standalone/native installers put per-tool binaries under %LOCALAPPDATA%\Programs
    // or %ProgramFiles%, either directly in the tool directory or in its `bin`.
    // Claude Code's Windows installer instead uses %USERPROFILE%\.local\bin
    // (`claude.exe`), and WinGet publishes shims into the WinGet\Links dir — both
    // are listed below.
    ...(localAppData
      ? [
          path.join(localAppData, "Programs", command),
          path.join(localAppData, "Programs", command, "bin"),
        ]
      : []),
    ...(programFiles
      ? [
          path.join(programFiles, command),
          path.join(programFiles, command, "bin"),
        ]
      : []),
    localAppData ? path.join(localAppData, "Programs", "cursor", "resources", "app", "bin") : "",
    localAppData ? path.join(localAppData, "Programs", "Microsoft VS Code", "bin") : "",
    localAppData ? path.join(localAppData, "Microsoft", "WinGet", "Links") : "",
    programFiles ? path.join(programFiles, "cursor", "resources", "app", "bin") : "",
    programFiles ? path.join(programFiles, "Microsoft VS Code", "bin") : "",
    programFiles ? path.join(programFiles, "Git", "cmd") : "",
    programFiles ? path.join(programFiles, "nodejs") : "",
    programFilesX86 ? path.join(programFilesX86, "Microsoft VS Code", "bin") : "",
    programData ? path.join(programData, "chocolatey", "bin") : "",
    scoop ? path.join(scoop, "shims") : path.join(homeDir, "scoop", "shims"),
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".npm-global", "bin"),
    path.join(homeDir, ".yarn", "bin"),
    path.join(homeDir, ".config", "yarn", "global", "node_modules", ".bin"),
    localAppData ? path.join(localAppData, "pnpm") : "",
    path.join(homeDir, ".pnpm-global", "bin"),
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".opencode", "bin"),
    path.join(homeDir, ".volta", "bin"),
    path.join(homeDir, ".asdf", "shims"),
    path.join(homeDir, ".asdf", "bin"),
    path.join(homeDir, ".nvm", "current", "bin"),
    path.join(homeDir, ".mise", "shims"),
    path.join(homeDir, ".mise", "bin"),
    path.join(homeDir, "bin"),
    bunInstall ? path.join(bunInstall, "bin") : "",
    voltaHome ? path.join(voltaHome, "bin") : "",
    pnpmHome || "",
    asdfDataDir ? path.join(asdfDataDir, "shims") : "",
    ...readNpmPrefixBinDirs(env),
    command === "codex" && programFiles ? path.join(programFiles, "Codex") : "",
    command === "codex" && localAppData ? path.join(localAppData, "Programs", "Codex") : "",
  ]);
}

function getUnixLikeKnownBinDirs(env: NodeJS.ProcessEnv, command: string): string[] {
  const homeDir = getHomeDir(env);
  const bunInstall = env.BUN_INSTALL?.trim();
  const voltaHome = env.VOLTA_HOME?.trim();
  const pnpmHome = env.PNPM_HOME?.trim();
  const asdfDataDir = env.ASDF_DATA_DIR?.trim();

  return uniqueNonEmpty([
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".npm-global", "bin"),
    path.join(homeDir, ".yarn", "bin"),
    path.join(homeDir, ".config", "yarn", "global", "node_modules", ".bin"),
    path.join(homeDir, "Library", "pnpm"),
    path.join(homeDir, ".pnpm-global", "bin"),
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".opencode", "bin"),
    path.join(homeDir, ".volta", "bin"),
    path.join(homeDir, ".asdf", "shims"),
    path.join(homeDir, ".asdf", "bin"),
    path.join(homeDir, ".nvm", "current", "bin"),
    path.join(homeDir, ".mise", "shims"),
    path.join(homeDir, ".mise", "bin"),
    path.join(homeDir, "bin"),
    bunInstall ? path.join(bunInstall, "bin") : "",
    voltaHome ? path.join(voltaHome, "bin") : "",
    pnpmHome || "",
    asdfDataDir ? path.join(asdfDataDir, "shims") : "",
    ...readNpmPrefixBinDirs(env),
    command === "codex" ? "/Applications/Codex.app/Contents/Resources" : "",
  ]);
}

function getKnownBinDirs(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  return process.platform === "win32"
    ? getWindowsKnownBinDirs(env, command)
    : getUnixLikeKnownBinDirs(env, command);
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Windows launcher extensions, in the order Windows itself would try them. */
export function windowsExecutableExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  // PATHEXT is conventionally uppercase while the files on disk are lowercase
  // (`claude.exe`, `codex.cmd`). Normalize so resolved paths match the real
  // filename; NTFS lookups are case-insensitive either way.
  const pathext = uniqueNonEmpty((env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"))
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase());
  // PATHEXT never lists .PS1 (PowerShell resolves scripts itself), but a
  // PowerShell-only shim is still a real, launchable install. Try it last so a
  // .exe/.cmd sibling always wins — those run under cmd.exe, .ps1 does not.
  if (!pathext.some((ext) => ext.toLowerCase() === ".ps1")) pathext.push(".ps1");
  return pathext;
}

/**
 * NTFS lookups ignore case, so a probe for `codex.cmd` succeeds against a file
 * actually named `codex.CMD` and vice versa. The resolved path is surfaced in
 * Settings and handed to other tools, so report the name as it is spelled on
 * disk instead of however PATHEXT happened to be cased.
 */
function withOnDiskCasing(candidatePath: string): string {
  if (process.platform !== "win32") return candidatePath;
  const dir = path.dirname(candidatePath);
  const base = path.basename(candidatePath);
  try {
    const actual = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === base.toLowerCase());
    return actual ? path.join(dir, actual) : candidatePath;
  } catch {
    return candidatePath;
  }
}

function resolveFromDirs(
  command: string,
  dirs: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const commandHasExtension = path.extname(command).length > 0;
  const extensions = process.platform === "win32" && !commandHasExtension
    ? windowsExecutableExtensions(env)
    : [];

  for (const dir of dirs) {
    // Windows cannot execute an extension-less file. `npm i -g` drops three
    // shims side by side — `codex` (a `#!/bin/sh` script for Git Bash),
    // `codex.cmd` and `codex.ps1` — and only the latter two are launchable
    // here. Trying `path.join(dir, command)` first therefore handed callers the
    // sh script: ADE's own spawns survived it because `resolveCliSpawnInvocation`
    // wraps extension-less commands in `cmd.exe`, which re-applies PATHEXT, but
    // every consumer that spawns the resolved path directly (the Claude Agent
    // SDK via `pathToClaudeCodeExecutable`, node-pty, provider SDKs) gets ENOENT.
    // Resolve the way Windows does: PATHEXT only. On other platforms the bare
    // name is the executable.
    const candidatePaths = extensions.length > 0
      // Uppercase second, for the rare case-sensitive Windows directory.
      ? extensions.flatMap((ext) => [
          path.join(dir, `${command}${ext}`),
          path.join(dir, `${command}${ext.toUpperCase()}`),
        ])
      : [path.join(dir, command)];

    for (const candidatePath of candidatePaths) {
      if (isExecutableFile(candidatePath)) return withOnDiskCasing(candidatePath);
    }
  }
  return null;
}

export function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return uniqueNonEmpty(pathValue.split(pathListDelimiter()));
}

export function mergePathEntries(...values: Array<string | undefined | null>): string {
  return uniqueNonEmpty(values.flatMap((value) => splitPathEntries(value ?? undefined))).join(pathListDelimiter());
}

export function augmentPathWithKnownCliDirs(
  pathValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return mergePathEntries(
    pathValue,
    ...["claude", "codex", "agent", "cursor-agent", "droid", "opencode"].map((command) =>
      getKnownBinDirs(command, env).join(pathListDelimiter())),
  );
}

function readShellPath(
  shellPath: string,
  shellFlag: "-lc" | "-ic",
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): string | null {
  try {
    const raw = execFileSync(
      shellPath,
      [shellFlag, `printf '${PATH_MARKER_START}%s${PATH_MARKER_END}' "$PATH"`],
      {
        encoding: "utf-8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        windowsHide: true,
      },
    );
    const startIdx = raw.indexOf(PATH_MARKER_START);
    const endIdx = raw.indexOf(PATH_MARKER_END, startIdx + PATH_MARKER_START.length);
    if (startIdx === -1 || endIdx === -1) return null;
    const resolved = raw.slice(startIdx + PATH_MARKER_START.length, endIdx).trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

export function augmentProcessPathWithShellAndKnownCliDirs(args?: {
  env?: NodeJS.ProcessEnv;
  includeInteractiveShell?: boolean;
  timeoutMs?: number;
}): string {
  const env = args?.env ?? process.env;

  if (process.platform === "win32") {
    // Windows has no direct `sh -ic` equivalent here; includeInteractiveShell
    // and timeoutMs are intentionally ignored in favor of env PATH + known CLI dirs.
    return augmentPathWithKnownCliDirs(getPathEnvValue(env), env);
  }

  if (process.platform !== "darwin" && process.platform !== "linux") {
    return getPathEnvValue(env) ?? process.env.PATH ?? "";
  }

  const shellPath = env.SHELL?.trim() || "/bin/sh";
  const timeoutMs = args?.timeoutMs ?? 1_000;
  const loginPath = readShellPath(shellPath, "-lc", timeoutMs, env);
  const interactivePath = args?.includeInteractiveShell
    ? readShellPath(shellPath, "-ic", timeoutMs, env)
    : null;

  return augmentPathWithKnownCliDirs(
    mergePathEntries(getPathEnvValue(env), loginPath, interactivePath),
    env,
  );
}

export function resolveExecutableFromKnownLocations(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutable | null {
  return executableCandidatesFromKnownLocations(command, env).next().value ?? null;
}
