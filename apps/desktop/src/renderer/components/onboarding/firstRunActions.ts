import type { OnboardingProjectDiscovery } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import type { FirstRunResult } from "./FirstRunFlow";

/**
 * The first-run flow's entry points, without the flow itself. Its screens
 * (and the provider logos they show) load when setup actually runs, not with
 * every launch.
 */
export function showFirstRunProjects(result: FirstRunResult): void {
  import("./FirstRunFlow")
    .then((module) => module.showFirstRunProjects(result))
    .catch((error: unknown) => captureError(error, { tags: { area: "onboarding.first_run_projects" } }));
}

/** Null on a host with nothing to discover (the hosted web client). */
export function prefetchOnboardingDiscovery(options: { fresh?: boolean } = {}): Promise<OnboardingProjectDiscovery | null> {
  return import("./FirstRunFlow").then((module) => module.prefetchOnboardingDiscovery(options));
}
