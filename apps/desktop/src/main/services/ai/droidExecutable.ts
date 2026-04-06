import type { DetectedAuth } from "./authDetector";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export type DroidExecutableResolution = {
  path: string;
  source: "auth" | "path" | "common-dir" | "fallback-command";
};

function findDroidAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "droid") continue;
    const candidate = entry.path.trim();
    if (candidate) return candidate;
  }
  return null;
}

/** Resolves the Factory Droid CLI binary (`droid`). */
export function resolveDroidExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): DroidExecutableResolution {
  const env = args?.env ?? process.env;

  const envPath = env.DROID_EXECUTABLE?.trim() || env.FACTORY_DROID_EXECUTABLE?.trim();
  if (envPath) {
    return { path: envPath, source: "path" };
  }

  const authPath = findDroidAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const resolved = resolveExecutableFromKnownLocations("droid", env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "droid", source: "fallback-command" };
}
