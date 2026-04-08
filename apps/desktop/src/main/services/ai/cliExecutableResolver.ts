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

function getHomeDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  return home && home.length > 0 ? home : os.homedir();
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

  return [...prefixes].map((prefix) => path.join(prefix, "bin"));
}

function getKnownBinDirs(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
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
    `${homeDir}/.local/bin`,
    `${homeDir}/.npm-global/bin`,
    `${homeDir}/.yarn/bin`,
    `${homeDir}/.config/yarn/global/node_modules/.bin`,
    `${homeDir}/Library/pnpm`,
    `${homeDir}/.pnpm-global/bin`,
    `${homeDir}/.bun/bin`,
    `${homeDir}/.opencode/bin`,
    `${homeDir}/.volta/bin`,
    `${homeDir}/.asdf/shims`,
    `${homeDir}/.asdf/bin`,
    `${homeDir}/.nvm/current/bin`,
    `${homeDir}/.mise/shims`,
    `${homeDir}/.mise/bin`,
    `${homeDir}/bin`,
    bunInstall ? path.join(bunInstall, "bin") : "",
    voltaHome ? path.join(voltaHome, "bin") : "",
    pnpmHome || "",
    asdfDataDir ? path.join(asdfDataDir, "shims") : "",
    ...readNpmPrefixBinDirs(env),
    command === "codex" ? "/Applications/Codex.app/Contents/Resources" : "",
  ]);
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function resolveFromDirs(
  command: string,
  dirs: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const pathext = process.platform === "win32"
    ? uniqueNonEmpty((env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";"))
    : [];
  const commandHasExtension = path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidatePaths = [path.join(dir, command)];
    if (process.platform === "win32" && !commandHasExtension) {
      for (const ext of pathext) {
        candidatePaths.push(path.join(dir, `${command}${ext}`));
      }
    }

    for (const candidatePath of candidatePaths) {
      if (isExecutableFile(candidatePath)) return candidatePath;
    }
  }
  return null;
}

export function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return uniqueNonEmpty(pathValue.split(path.delimiter));
}

export function mergePathEntries(...values: Array<string | undefined | null>): string {
  return uniqueNonEmpty(values.flatMap((value) => splitPathEntries(value ?? undefined))).join(path.delimiter);
}

export function augmentPathWithKnownCliDirs(
  pathValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return mergePathEntries(
    pathValue,
    getKnownBinDirs("claude", env).join(path.delimiter),
    getKnownBinDirs("codex", env).join(path.delimiter),
    getKnownBinDirs("agent", env).join(path.delimiter),
    getKnownBinDirs("opencode", env).join(path.delimiter),
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
        timeout: timeoutMs,
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
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return args?.env?.PATH ?? process.env.PATH ?? "";
  }

  const env = args?.env ?? process.env;
  const shellPath = env.SHELL?.trim() || "/bin/sh";
  const timeoutMs = args?.timeoutMs ?? 1_000;
  const loginPath = readShellPath(shellPath, "-lc", timeoutMs, env);
  const interactivePath = args?.includeInteractiveShell
    ? readShellPath(shellPath, "-ic", timeoutMs, env)
    : null;

  return augmentPathWithKnownCliDirs(
    mergePathEntries(env.PATH, loginPath, interactivePath),
    env,
  );
}

export function resolveExecutableFromKnownLocations(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutable | null {
  const fromPath = resolveFromDirs(command, splitPathEntries(env.PATH), env);
  if (fromPath) {
    return { path: fromPath, source: "path" };
  }

  const fromKnownDirs = resolveFromDirs(command, getKnownBinDirs(command, env), env);
  if (fromKnownDirs) {
    return { path: fromKnownDirs, source: "known-dir" };
  }

  return null;
}
