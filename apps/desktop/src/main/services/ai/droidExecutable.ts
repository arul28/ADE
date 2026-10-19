import type { DetectedAuth } from "./authDetector";
import { isExecutableFile } from "./cliExecutableResolver";
import { resolveCurrentPinnedTool, resolvePreviousPinnedTool } from "../../../../../ade-cli/src/services/tools/pinnedTool";

/**
 * Where ADE's Droid binary is. `fallback-command` means ADE has no copy on
 * this machine (`path` is empty). `auth` and `common-dir` are no longer
 * produced; `path` labels the dev/test override, as it always has.
 */
export type DroidExecutableResolution = {
  path: string;
  source: "tools-cache" | "auth" | "path" | "common-dir" | "fallback-command";
};

/**
 * ADE's own Factory Droid CLI: the dev/test override (`DROID_EXECUTABLE`), the
 * current pin in the tools cache, then the previous pin while a new one
 * downloads. Never a `droid` the user installed. The pin is the native
 * `droid[.exe]`, so the Droid SDK can spawn it with no shell.
 *
 * `auth` is accepted for call-site compatibility and ignored.
 */
export function resolveDroidExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}): DroidExecutableResolution {
  const env = args?.env ?? process.env;

  const envPath = env.DROID_EXECUTABLE?.trim() || env.FACTORY_DROID_EXECUTABLE?.trim();
  if (envPath) {
    return { path: envPath, source: "path" };
  }

  const platform = args?.platform ?? process.platform;
  const context = { env, platform: args?.platform, arch: args?.arch };
  for (const pinned of [resolveCurrentPinnedTool("droid", context), resolvePreviousPinnedTool("droid", context)]) {
    if (pinned && isExecutableFile(pinned.entryPath, platform)) {
      return { path: pinned.entryPath, source: "tools-cache" };
    }
  }

  return { path: "", source: "fallback-command" };
}
