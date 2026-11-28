import assert from "node:assert/strict";
import test from "node:test";
import { findUnshippedBundlePackages, unshippedBundlePackagesMessage } from "./bundle-packages-gate.mjs";

// The lockfile of a runtime build: `npm ci` in apps/ade-cli only.
const lock = {
  packages: {
    "": { name: "ade-cli" },
    "node_modules/chokidar": {},
    "node_modules/@scope/runtime-dep": {},
    "node_modules/vitest": { dev: true },
    "node_modules/chokidar/node_modules/readdirp": {},
  },
};

function metafile({ external = [], inputs = [] }) {
  return {
    inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
    outputs: {
      "dist/cli.cjs": { imports: external.map((specifier) => ({ path: specifier, external: true, kind: "dynamic-import" })) },
      "dist/cli.cjs.map": { imports: [{ path: "not-installed-in-a-map", external: true }] },
    },
  };
}

for (const [label, meta, expected] of [
  [
    "an SDK the bundle leaves external that apps/ade-cli does not install (the Copilot SDK on the runtime)",
    metafile({ external: ["@github/copilot-sdk"] }),
    [{ name: "@github/copilot-sdk", reason: "external-not-installed", outputs: ["dist/cli.cjs"] }],
  ],
  [
    "an external that is only a dev install",
    metafile({ external: ["vitest/config"] }),
    [{ name: "vitest", reason: "external-not-installed", outputs: ["dist/cli.cjs"] }],
  ],
  [
    "an external that is only nested under another package",
    metafile({ external: ["readdirp"] }),
    [{ name: "readdirp", reason: "external-not-installed", outputs: ["dist/cli.cjs"] }],
  ],
  [
    "a package inlined from the desktop's node_modules that apps/ade-cli does not install",
    metafile({ inputs: ["../desktop/node_modules/desktop-only/index.js"] }),
    [{ name: "desktop-only", reason: "inlined-from-outside", outputs: [] }],
  ],
  [
    "builtins, production installs (scoped or with a subpath), and code inlined from apps/ade-cli's own installs",
    metafile({
      external: ["node:fs", "fs", "chokidar", "@scope/runtime-dep/sub/path"],
      inputs: ["src/cli.ts", "node_modules/anything/index.js", "../desktop/node_modules/chokidar/index.js"],
    }),
    [],
  ],
]) {
  test(`bundle packages gate: ${label}`, () => {
    const problems = findUnshippedBundlePackages({ metafile: meta, lock });
    assert.deepEqual(problems, expected);
    assert.equal(unshippedBundlePackagesMessage(problems) === null, expected.length === 0);
  });
}
