/**
 * Desktop face of ADE's pinned Meta Muse Code binary.
 *
 * The resolver, the background fetch and the status are Electron-free and live
 * in `apps/ade-cli/src/services/tools/muse.ts`, so the brain (`ade triage`) and
 * this app share one implementation. This file re-exports them and owns the one
 * blocker sentence Settings and the provider status both show.
 */
import { isDevRun } from "../../../../../ade-cli/src/services/tools/muse";
import type { MuseExecutableResolution } from "../../../../../ade-cli/src/services/tools/muse";

export {
  ensureMuseBinary,
  getMuseBinaryStatus,
  resolveMuseExecutable,
  startMuseBinaryFetch,
  type MuseExecutableResolution,
} from "../../../../../ade-cli/src/services/tools/muse";

/**
 * ADE's provider override for a Muse host (`ADE_MUSE_PROVIDER`, Muse's offline
 * `echo` provider for developers and tests). Honored only in a dev run, like
 * `ADE_MUSE_EXECUTABLE`, so a packaged app never routes a chat to it.
 */
export function museProviderOverride(env: NodeJS.ProcessEnv): string | null {
  if (!isDevRun(env)) return null;
  return env.ADE_MUSE_PROVIDER?.trim() || null;
}

/**
 * Why the pinned Muse build cannot run on this machine, as one sentence, or null
 * when it can. Provider status and the provider's binary resolver both use it,
 * so the two never say different things about the same missing build.
 */
export function museBinaryBlocker(resolution: MuseExecutableResolution): string | null {
  if (resolution.path) return null;
  if (resolution.source === "unsupported") return "ADE has no pinned Muse build for this platform.";
  const version = resolution.pinnedVersion ? ` (${resolution.pinnedVersion})` : "";
  return resolution.fetchPending
    ? `ADE's pinned Muse build${version} is not downloaded yet. Download it from Settings > Providers.`
    : `ADE's pinned Muse build${version} is not available.`;
}
