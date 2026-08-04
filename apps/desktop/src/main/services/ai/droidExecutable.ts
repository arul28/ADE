import type { DetectedAuth } from "./authDetector";
import { resolveExecutableCandidatesFromKnownLocations } from "./cliExecutableResolver";
import { preferNativeExecutablePath } from "../shared/processExecution";

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

  // The Droid chat SDK hands this path straight to `spawn()` with no shell
  // (`ProcessTransport.connect()`), and since CVE-2024-27980 Node refuses a bare
  // `.cmd`/`.bat` spawn with `EINVAL` (errno -4071) — a session whose only
  // resolution was `%APPDATA%\npm\droid.cmd` died on the first message. Where a
  // real `droid.exe` is installed alongside the shim, prefer it so nothing has
  // to be wrapped at all; the spawn patch in droidSdkWindowsHide.ts covers the
  // shim-only installs that remain.
  const candidates = resolveExecutableCandidatesFromKnownLocations("droid", env);
  const preferred = preferNativeExecutablePath(candidates.map((candidate) => candidate.path));
  const resolved = candidates.find((candidate) => candidate.path === preferred);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "droid", source: "fallback-command" };
}
