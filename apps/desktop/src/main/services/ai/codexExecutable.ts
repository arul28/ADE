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
  const env = args?.env ?? process.env;
  const authPath = findCodexAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const envPath = env.CODEX_EXECUTABLE?.trim() || env.CODEX_EXECUTABLE_PATH?.trim();
  if (envPath) {
    return { path: envPath, source: "path" };
  }

  const resolved = resolveExecutableFromKnownLocations("codex", env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "codex", source: "fallback-command" };
}
