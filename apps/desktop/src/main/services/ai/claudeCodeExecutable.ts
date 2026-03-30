import type { DetectedAuth } from "./authDetector";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export type ClaudeCodeExecutableResolution = {
  path: string;
  source: "env" | "auth" | "path" | "common-dir" | "fallback-command";
};

function findClaudeAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "claude") continue;
    const candidate = entry.path.trim();
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

export function resolveClaudeCodeExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): ClaudeCodeExecutableResolution {
  const env = args?.env ?? process.env;
  const envPath = env.CLAUDE_CODE_EXECUTABLE_PATH?.trim();
  if (envPath) {
    return { path: envPath, source: "env" };
  }

  const authPath = findClaudeAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const resolved = resolveExecutableFromKnownLocations("claude", env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "claude", source: "fallback-command" };
}
