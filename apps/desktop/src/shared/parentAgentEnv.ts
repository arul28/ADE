import path from "node:path";

/**
 * Environment variables that describe the Claude Code session a process was
 * started from, not a setting of the process itself.
 *
 * ADE is a host, never a child of the Claude session that happened to start
 * it (a dev app or brain launched from an agent shell). Left in place, the
 * markers reach every terminal ADE opens: a `claude` there believes it is a
 * child session and turns transcript saving off ("inherited
 * CLAUDE_CODE_CHILD_SESSION marker"), so a resumed session silently stops
 * recording. User settings such as `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` are
 * left alone.
 */
export const PARENT_CLAUDE_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
] as const;

/** Removes the parent-session markers in place; returns the keys it removed. */
export function stripParentClaudeSessionEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of PARENT_CLAUDE_SESSION_ENV_KEYS) {
    if (key in env) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Provider config-home variables ADE sets in an agent's shell to pin it to one
 * provider account (`<ADE home>/provider-homes/<provider>/<account>`).
 *
 * A host process (a brain, the desktop app) that inherits one reads it as the
 * machine's own default config home: on 2026-10-20 dev brains started from
 * agent shells each re-read the Default Claude account as their agent's
 * account and rewrote `provider-instances.json` with a false "replaced
 * account". A value outside ADE's provider homes is the user's own setting
 * (a shell profile) and is kept.
 */
export const INHERITED_PROVIDER_HOME_ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/** Whether `dir` sits inside an ADE home's `provider-homes` directory. */
export function isAdeProviderHomePath(
  dir: string,
  adeHome?: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const comparisonPath = (value: string): string => caseInsensitive ? value.toLowerCase() : value;
  const resolved = pathApi.resolve(dir);
  if (adeHome?.trim()) {
    const root = pathApi.resolve(adeHome.trim(), "provider-homes");
    const relative = pathApi.relative(comparisonPath(root), comparisonPath(resolved));
    if (
      relative
      && relative !== ".."
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative)
    ) return true;
  }
  // Any ADE home (`~/.ade`, `~/.ade-alpha`, …): an agent of one channel can
  // start a brain under another.
  const parts = resolved.split(/[\\/]+/u).map(comparisonPath);
  return parts.some((part, index) => (
    part === "provider-homes" && index > 0 && parts[index - 1]?.startsWith(".ade") && index < parts.length - 1
  ));
}

/** Removes provider config homes inherited from an agent shell; returns the keys it removed. */
export function stripInheritedProviderHomeEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of INHERITED_PROVIDER_HOME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value || !isAdeProviderHomePath(value, env.ADE_HOME)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}
