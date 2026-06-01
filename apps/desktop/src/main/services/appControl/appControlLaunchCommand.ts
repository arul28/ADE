import fs from "node:fs";
import path from "node:path";

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

export function rewritePackageScriptElectronLaunch(command: string, debugFlags: string[], fallbackCwd: string): string | null {
  const match = command.trim().match(/^(?<prefix>.*?)(?<env>(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*)(?<manager>npm|pnpm|yarn|bun)\s+(?:run\s+)?(?<script>[A-Za-z0-9:_./-]+)\s*$/);
  const groups = match?.groups;
  if (!groups) return null;
  const prefix = groups.prefix ?? "";
  const envPrefix = groups.env?.trim() ?? "";
  const scriptName = groups.script;
  if (!scriptName) return null;

  let packageDir = fallbackCwd;
  const cdMatches = Array.from(prefix.matchAll(/(?:^|[;&|]\s*)cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))\s*&&/g));
  const lastCd = cdMatches.at(-1);
  if (lastCd?.[1]) packageDir = path.resolve(fallbackCwd, unquoteShellValue(lastCd[1]));

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
    const expandedEnvPrefix = [`PATH=${shellQuote(packageBinPath)}:$PATH`, envPrefix].filter(Boolean).join(" ");
    return `${prefix}${prependEnvToShellSegments(rewrittenScript, expandedEnvPrefix)}`;
  } catch {
    return null;
  }
}
