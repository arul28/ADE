/**
 * An esbuild plugin that gives each Node built-in one import wrapper per bundle.
 *
 * A CommonJS bundle turns `import fs from "node:fs"` (and `import * as fs`)
 * into `__toESM(require("node:fs"))` in every module that writes it. Each call
 * builds a new object with one getter closure, one closure scope and one
 * accessor pair for each export of the module. Electron main had 1,265 of
 * these (fs 434 times, path 528, os 167): 63,000 getters and about 4 MB of
 * its 33 MB heap, all made again at every launch.
 *
 * Here an `import` statement of a built-in resolves to one small ES module per
 * built-in instead, which re-exports it: `export *` copies the getters once,
 * and `export default` hands the module itself. Every importer then binds to
 * that one module. The getters read the built-in's live properties, as the
 * per-module wrappers did, so a later patch of a built-in (Sentry, for one)
 * still shows. `require()` calls and dynamic `import()` are left as written.
 *
 * tsup's `node:` plugin runs before any user plugin and would claim every
 * `node:` import first, so the config sets `removeNodeProtocol: false` and
 * this plugin strips the prefix in its place.
 */
import { builtinModules } from "node:module";

type OnResolveArgs = { path: string; kind: string; namespace: string };
type OnLoadArgs = { path: string };
type PluginBuildLike = {
  onResolve(
    options: { filter: RegExp; namespace?: string },
    callback: (args: OnResolveArgs) => { path: string; namespace?: string; external?: boolean } | undefined,
  ): void;
  onLoad(
    options: { filter: RegExp; namespace: string },
    callback: (args: OnLoadArgs) => { contents: string; loader: "js"; resolveDir: string },
  ): void;
};

const NAMESPACE = "ade-shared-builtin";
const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

function builtinName(specifier: string): string | null {
  const name = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return BUILTINS.has(name) ? name : null;
}

export function sharedNodeBuiltins() {
  return {
    name: "ade-shared-node-builtins",
    setup(build: PluginBuildLike) {
      build.onResolve({ filter: /^(node:)?[a-z0-9_/]+$/ }, (args) => {
        const name = builtinName(args.path);
        if (name && args.kind === "import-statement" && args.namespace !== NAMESPACE) {
          return { path: name, namespace: NAMESPACE };
        }
        // Everything else stays as it was written: external, and with any
        // `node:` prefix kept. `node:sqlite` and `node:test` are prefix-only
        // (not in `builtinModules`), so cutting the prefix would turn
        // `require("node:sqlite")` into `require("sqlite")`, an npm package
        // that is not there: `resolveSqliteBackup` then finds no `backup` and
        // the pre-upgrade database copy is skipped. Node reads `node:` in a
        // `require` on every supported version.
        if (args.path.startsWith("node:")) return { path: args.path, external: true };
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        // `require` rather than a default import, which would add a wrapper of its own.
        contents: `export * from "node:${args.path}";\nexport default require("node:${args.path}");\n`,
        loader: "js",
        resolveDir: process.cwd(),
      }));
    },
  };
}
