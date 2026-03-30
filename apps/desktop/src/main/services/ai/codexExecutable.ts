import type { DetectedAuth } from "./authDetector";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export type CodexExecutableResolution = {
  path: string;
  source: "auth" | "path" | "common-dir" | "fallback-command";
};

function findCodexAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "codex") continue;
    const candidate = entry.path.trim();
    if (candidate) return candidate;
  }
  return null;
}

export function resolveCodexExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): CodexExecutableResolution {
  const authPath = findCodexAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const resolved = resolveExecutableFromKnownLocations("codex", args?.env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "codex", source: "fallback-command" };
}
