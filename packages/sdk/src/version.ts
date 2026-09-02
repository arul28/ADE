/**
 * The package version, injected at build time from package.json.
 *
 * A support conversation about an embedder's chat starts with "which SDK is
 * running?", and the answer has to survive bundling: an app that bundles this
 * package into its own output has no `node_modules/@ade-dev/sdk/package.json`
 * to read, and reading one at runtime differs between the ESM and CJS builds.
 * So the value is substituted by tsup's `define` (see tsup.config.ts) and the
 * literal below is only what a source-level consumer — vitest, `tsx`, a
 * repo-local import — sees.
 *
 * `packageVersionForBuild()` in tsup.config.ts reads package.json, so the two
 * cannot drift in a published build; a test pins the source literal to
 * package.json so they cannot drift here either.
 */
declare const __ADE_SDK_VERSION__: string | undefined;

export const SDK_VERSION: string =
  typeof __ADE_SDK_VERSION__ === "string" ? __ADE_SDK_VERSION__ : "0.2.0";
