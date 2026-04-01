import type { DetectedAuth } from "./authDetector";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export type CursorAgentExecutableResolution = {
  path: string;
  source: "auth" | "path" | "common-dir" | "fallback-command";
};

function findCursorAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "cursor") continue;
    const candidate = entry.path.trim();
    if (candidate) return candidate;
  }
  return null;
}

/** Resolves the Cursor CLI binary (`agent`). */
export function resolveCursorAgentExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): CursorAgentExecutableResolution {
  const env = args?.env ?? process.env;
  const authPath = findCursorAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const envPath = env.CURSOR_AGENT_EXECUTABLE?.trim() || env.AGENT_EXECUTABLE?.trim();
  if (envPath) {
    return { path: envPath, source: "path" };
  }

  const resolved = resolveExecutableFromKnownLocations("agent", env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "agent", source: "fallback-command" };
}
