/**
 * Whether this brain reports to Sentry and PostHog as the release it says it is.
 *
 * One answer for Sentry (`initBrain.ts`), the brain's PostHog channel
 * (`cli.ts`, `bootstrap.ts`) and its automatic diagnostic reports, so a brain
 * that is development to one is development to all of them. A brain is a
 * development build when:
 * - the bundle was not built by a release workflow (`__ADE_UNRELEASED_VERSION__`,
 *   `apps/ade-cli/tsup.config.ts`): a dev launcher build, a plain
 *   `npm run build`, a bundle copied elsewhere (`/opt/ade-dev`);
 * - it runs from a source checkout (`apps/ade-cli/dist`), whatever bundle it is;
 * - the dev launcher started it (`ADE_DEV_BRAIN=1`, `scripts/dev-shared.mjs`).
 *
 * Decided from the bundle and where it runs, not from `ADE_RUNTIME_PACKAGED`: a
 * dev brain started from an installed ADE's terminal inherits that variable.
 */
import { isTruthyEnvFlag } from "../../../desktop/src/shared/doNotTrack";
import { isSourceCheckoutRuntimeModule } from "../runtimePackaging";

/** True when the bundle kept a source placeholder version (`tsup.config.ts`). */
declare const __ADE_UNRELEASED_VERSION__: boolean | undefined;

function currentModulePath(): string {
  return typeof __filename === "string" ? __filename : process.argv[1] ?? "";
}

export function brainReportsAsRelease(
  env: NodeJS.ProcessEnv = process.env,
  modulePath: string = currentModulePath(),
): boolean {
  const unreleased = typeof __ADE_UNRELEASED_VERSION__ === "boolean" && __ADE_UNRELEASED_VERSION__;
  if (unreleased) return false;
  if (isTruthyEnvFlag(env.ADE_DEV_BRAIN)) return false;
  return !isSourceCheckoutRuntimeModule(modulePath);
}
