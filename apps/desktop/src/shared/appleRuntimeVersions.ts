import type { AppleRuntimeEntry, AppleRuntimeInstallState } from "./types/iosSimulator";

/** An install that is still running on the owning machine. */
export function appleRuntimeInstallActive(install: AppleRuntimeInstallState | null | undefined): boolean {
  return Boolean(install && (install.phase === "checking" || install.phase === "preparing"
    || install.phase === "downloading" || install.phase === "installing"));
}

/** Sorts a runtime string so "iOS 26.1" beats "iOS 18.4" numerically, not lexically. */
export function appleRuntimeScore(runtime: string): number {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(runtime);
  if (!match) return 0;
  return (Number(match[1]) * 1_000_000) + (Number(match[2] ?? 0) * 1_000) + Number(match[3] ?? 0);
}

/**
 * The newest installed runtime that runs a model, newer than `after` when
 * given and never one in `excluding` (runtimes the same removal deletes).
 *
 * Per model, not per runtime: iOS 27.1 runs only the Duo, so an iPhone 17 on
 * iOS 26.3 moves to iOS 27.0, not 27.1. One rule for where a simulator can
 * move when its runtime goes (the manager does the move; the confirmation
 * names what cannot) and for which runtime "Install & create" builds on.
 */
export function newestAppleRuntimeRunning<T extends Pick<AppleRuntimeEntry, "runtimeIdentifier" | "platform" | "version" | "deviceTypes">>(
  runtimes: readonly T[],
  deviceTypeIdentifier: string | null,
  options: { after?: Pick<AppleRuntimeEntry, "platform" | "version">; excluding?: ReadonlySet<string> } = {},
): T | null {
  if (!deviceTypeIdentifier) return null;
  const { after, excluding } = options;
  let best: T | null = null;
  for (const candidate of runtimes) {
    if (excluding?.has(candidate.runtimeIdentifier)) continue;
    if (after && (candidate.platform !== after.platform || appleRuntimeScore(candidate.version) <= appleRuntimeScore(after.version))) continue;
    if (!candidate.deviceTypes.some((type) => type.identifier === deviceTypeIdentifier)) continue;
    if (!best || appleRuntimeScore(candidate.version) > appleRuntimeScore(best.version)) best = candidate;
  }
  return best;
}
