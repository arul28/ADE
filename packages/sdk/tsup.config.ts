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

const define = { __ADE_SDK_VERSION__: JSON.stringify(packageVersionForBuild()) };

/**
 * Two passes, because the three Electron entries do not all run on Node.
 *
 * `src/index.ts` and `src/electron/index.ts` are main-process code and build for
 * Node. `src/electron/preload.ts` and `src/electron/renderer.ts` run inside a
 * renderer: the preload under `sandbox: true`, where there is no module
 * resolution at all, and the renderer under a strict CSP. Both must therefore
 * build for the browser platform and must come out as ONE self-contained file
 * each, which is why `splitting` stays off — a shared chunk would be an import
 * a sandboxed preload cannot resolve.
 */
export default defineConfig([
  {
    define,
    entry: ["src/index.ts", "src/electron/index.ts"],
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
  },
  {
    define,
    entry: ["src/electron/preload.ts", "src/electron/renderer.ts"],
    outDir: "dist/electron",
    format: ["esm", "cjs"],
    dts: true,
    // The Node pass owns `clean`. A second clean here would delete it.
    clean: false,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    noExternal: [],
    splitting: false,
  },
  {
    define,
    // A classic-script build of the renderer half, for a page that has no
    // bundler. A renderer loaded from `file://` cannot load an ES module at all
    // (Chromium blocks it as a cross-origin request), so an app without a build
    // step needs `<script src="…renderer.global.js">` and `window.AdeElectron`.
    entry: ["src/electron/renderer.ts"],
    outDir: "dist/electron",
    format: ["iife"],
    globalName: "AdeElectron",
    dts: false,
    clean: false,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    noExternal: [],
    splitting: false,
  },
]);
