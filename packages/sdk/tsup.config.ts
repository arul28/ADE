import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

/**
 * Read the version from package.json at build time so `SDK_VERSION` in a
 * published build can never disagree with the version on the registry.
 */
function packageVersionForBuild(): string {
  const manifestPath = fileURLToPath(new URL("./package.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/sdk/package.json has no usable version field");
  }
  return manifest.version;
}

export default defineConfig({
  define: { __ADE_SDK_VERSION__: JSON.stringify(packageVersionForBuild()) },
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  // The package must stay dependency-free: nothing but node builtins may be
  // bundled, so an accidental import of a third-party module fails the build
  // rather than silently shipping a vendored copy.
  noExternal: [],
  splitting: false,
});
