import fs from "node:fs";
import path from "node:path";
import { commandArrayToLine, parseCommandLine } from "../../../shared/shell";
import type { WindowsShellKind } from "../../../shared/types";

export type AppControlDirectLaunch = {
  command: string;
  args: string[];
  commandForDisplay: string;
  env?: Record<string, string>;
};

export type AppControlPackageLaunch = AppControlDirectLaunch & {
  cwd: string;
};

type LaunchOptions = {
  platform?: NodeJS.Platform;
  shell?: WindowsShellKind;
};

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function commandForwardsAppControlDebug(command: string): boolean {
  return /\{ADE_APP_CONTROL_DEBUG_FLAGS\}|\bADE_APP_CONTROL_(?:DEBUG_FLAGS|CDP_PORT|REMOTE_DEBUGGING_PORT)\b|--remote-debugging-port\b/.test(command);
}

export function commandLooksLikePackageScriptLaunch(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[A-Za-z0-9:_./-]+)\s*$/.test(command.trim());
}

export function commandLooksLikeDirectElectronLaunch(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:npx\s+)?electron(?:\s+[^;&|]*)?\s*$/.test(command.trim());
}

export function unquoteShellValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function insertDebugFlagsIntoDirectElectronCommand(command: string, debugFlags: string[]): string {
  const flags = debugFlags.map(shellQuote).join(" ");
  return command.replace(
    /((?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:npx\s+)?electron)(?=\s|$)/,
    `$1 ${flags}`,
  );
}

function takeLeadingEnv(input: string): { env: Record<string, string>; rest: string } {
  const env: Record<string, string> = {};
  let rest = input.trim();
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))(?:\s+|$)/;
  while (rest) {
    const match = rest.match(assignment);
    if (!match) break;
    env[match[1]!] = match[2] ?? match[3] ?? match[4] ?? "";
    rest = rest.slice(match[0].length).trimStart();
  }
  return { env, rest };
}

export function resolveDirectElectronLaunch(
  command: string,
  debugFlags: string[],
  options: LaunchOptions = {},
): AppControlDirectLaunch | null {
  const platform = options.platform ?? process.platform;
  const { env, rest } = takeLeadingEnv(command);
  // Windows' CRT argv rules do not recognize PowerShell-style single quotes.
  // Accepting them here would silently split paths containing spaces; leave
  // those commands to the selected shell, which owns their quoting semantics.
  if (platform === "win32" && rest.includes("'")) return null;
  let argv: string[];
  try {
    argv = parseCommandLine(rest, { platform });
  } catch {
    return null;
  }
  if (argv.some((arg) => arg === "&&" || arg === "||" || arg === ";" || arg === "|")) {
    return null;
  }

  const usesNpx = argv[0]?.toLowerCase() === "npx" && argv[1]?.toLowerCase() === "electron";
  const directElectron = argv[0]?.toLowerCase() === "electron" || argv[0]?.toLowerCase() === "electron.exe";
  if (!usesNpx && !directElectron) return null;

  const executable = argv[0]!;
  const prefixArgs = usesNpx ? [argv[1]!] : [];
  const appArgs = argv.slice(usesNpx ? 2 : 1);
  const args = [...prefixArgs, ...debugFlags, ...appArgs];
  return {
    command: executable,
    args,
    commandForDisplay: commandArrayToLine([executable, ...args], { platform }),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

function packageScriptMatch(command: string): RegExpMatchArray | null {
  return command.trim().match(
    /^(?<prefix>.*?)(?<env>(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*)(?<manager>npm|pnpm|yarn|bun)\s+(?:run\s+)?(?<script>[A-Za-z0-9:_./-]+)\s*$/,
  );
}

function packageDirectory(prefix: string, fallbackCwd: string): string | null {
  let packageDir = fallbackCwd;
  const cdPattern = /(?:^|[;&|]\s*)cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))\s*&&/g;
  const matches = Array.from(prefix.matchAll(cdPattern));
  if (prefix.replace(cdPattern, "").trim()) return null;
  const lastCd = matches.at(-1);
  if (lastCd?.[1]) {
    packageDir = path.resolve(fallbackCwd, unquoteShellValue(lastCd[1]));
  }
  return packageDir;
}

export function resolvePackageScriptElectronLaunch(
  command: string,
  debugFlags: string[],
  fallbackCwd: string,
  options: LaunchOptions = {},
): AppControlPackageLaunch | null {
  const groups = packageScriptMatch(command)?.groups;
  if (!groups?.script) return null;
  const packageDir = packageDirectory(groups.prefix ?? "", fallbackCwd);
  if (!packageDir) return null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const script = packageJson.scripts?.[groups.script];
    if (typeof script !== "string" || commandForwardsAppControlDebug(script)) return null;
    const resolved = resolveDirectElectronLaunch(script, debugFlags, options);
    if (!resolved) return null;

    const platform = options.platform ?? process.platform;
    const executable = path.join(
      packageDir,
      "node_modules",
      ".bin",
      platform === "win32" ? "electron.cmd" : "electron",
    );
    const args = resolved.args[0]?.toLowerCase() === "electron"
      ? resolved.args.slice(1)
      : resolved.args;
    const env = {
      ...takeLeadingEnv(groups.env ?? "").env,
      ...(resolved.env ?? {}),
    };
    return {
      command: executable,
      args,
      cwd: packageDir,
      commandForDisplay: commandArrayToLine([executable, ...args], { platform }),
      ...(Object.keys(env).length ? { env } : {}),
    };
  } catch {
    return null;
  }
}

function prependEnvToShellSegments(script: string, envPrefix: string): string {
  const trimmedEnv = envPrefix.trim();
  if (!trimmedEnv) return script;
  return script
    .split(/(\s*&&\s*)/)
    .map((segment) => {
      if (/^\s*&&\s*$/.test(segment)) return segment;
      const trimmed = segment.trim();
      return trimmed ? `${trimmedEnv} ${trimmed}` : segment;
    })
    .join("");
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdSetValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/"/g, "\"\"")
    .replace(/[\r\n]/g, " ");
}

/**
 * Rewrites a native Windows path into the MSYS form Git Bash expects:
 * `C:\Users\ade` becomes `/c/Users/ade`. Only a drive-letter root is rewritten;
 * a path that already has no drive (a UNC share, or a POSIX path) is passed
 * through with separators normalised, because MSYS understands those as-is and
 * inventing a drive letter for them would corrupt them.
 */
export function gitBashPath(value: string): string {
  const normalized = value.split(String.fromCharCode(92)).join("/");
  const drivePath = normalized.match(/^([a-z]):\/(.*)$/i);
  if (!drivePath) return normalized;
  return `/${drivePath[1]!.toLowerCase()}/${drivePath[2]}`;
}

export function rewritePackageScriptElectronLaunch(
  command: string,
  debugFlags: string[],
  fallbackCwd: string,
  options: LaunchOptions = {},
): string | null {
  const groups = packageScriptMatch(command)?.groups;
  if (!groups?.script) return null;
  const prefix = groups.prefix ?? "";
  const envPrefix = groups.env?.trim() ?? "";
  const scriptName = groups.script;
  const packageDir = packageDirectory(prefix, fallbackCwd);
  if (!packageDir) return null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const script = packageJson.scripts?.[scriptName];
    if (typeof script !== "string") return null;
    if (commandForwardsAppControlDebug(script) || !/\belectron(?:\s|$)/.test(script)) return null;
    const rewrittenScript = insertDebugFlagsIntoDirectElectronCommand(script, debugFlags);
    if (rewrittenScript === script) return null;
    const packageBinPath = path.join(packageDir, "node_modules", ".bin");
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
      const parsedEnv = takeLeadingEnv(envPrefix).env;
      const shell = options.shell ?? "powershell";
      if (shell === "cmd") {
        const assignments = [
          `cd /d "${quoteCmdSetValue(packageDir)}"`,
          `set "PATH=${quoteCmdSetValue(packageBinPath)};%PATH%"`,
          ...Object.entries(parsedEnv).map(
            ([key, value]) => `set "${key}=${quoteCmdSetValue(value)}"`,
          ),
        ];
        return `${assignments.join(" && ")} && ${rewrittenScript}`;
      }

      if (shell === "git-bash") {
        const expandedEnvPrefix = [
          `PATH=${shellQuote(gitBashPath(packageBinPath))}:$PATH`,
          ...Object.entries(parsedEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
        ].join(" ");
        return `cd -- ${shellQuote(gitBashPath(packageDir))} && ${prependEnvToShellSegments(rewrittenScript, expandedEnvPrefix)}`;
      }

      const assignments = [
        `Set-Location -LiteralPath ${quotePowerShellLiteral(packageDir)}`,
        `$env:PATH = ${quotePowerShellLiteral(`${packageBinPath};`)} + $env:PATH`,
        ...Object.entries(parsedEnv).map(
          ([key, value]) => `$env:${key} = ${quotePowerShellLiteral(value)}`,
        ),
      ];
      const powershellScript = rewrittenScript
        .split(/\s*&&\s*/)
        .join("; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ");
      return `${assignments.join("; ")}; ${powershellScript}`;
    }

    const expandedEnvPrefix = [`PATH=${shellQuote(packageBinPath)}:$PATH`, envPrefix].filter(Boolean).join(" ");
    return `${prefix}${prependEnvToShellSegments(rewrittenScript, expandedEnvPrefix)}`;
  } catch {
    return null;
  }
}
