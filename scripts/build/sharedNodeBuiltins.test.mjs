import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedNodeBuiltins } from "./sharedNodeBuiltins.ts";

/*
 * The build plugin rewrites every Node built-in import, and the text it writes
 * is what the packaged brain runs. `node:sqlite` is prefix-only (it is not in
 * `builtinModules`), so an external import of it must keep its prefix: without
 * `node:`, Node looks for an npm package named `sqlite`, finds none, and
 * `resolveSqliteBackup` (`dbCompatRecord.ts`) skips the pre-upgrade copy of the
 * project database.
 */

/** The plugin's two hooks, captured so a test can drive them without esbuild. */
function capture() {
  let resolveHook = null;
  let loadHook = null;
  sharedNodeBuiltins().setup({
    onResolve: (_options, callback) => {
      resolveHook = callback;
    },
    onLoad: (_options, callback) => {
      loadHook = callback;
    },
  });
  return {
    resolve: (args) => resolveHook?.(args),
    load: (path) => loadHook?.({ path }),
  };
}

test("an external built-in keeps its node: prefix, so node:sqlite still resolves to the built-in", () => {
  const plugin = capture();
  // A `require` of a prefix-only module: Node needs the prefix, and there is no
  // npm package to fall back to.
  assert.deepEqual(
    plugin.resolve({ path: "node:sqlite", kind: "require-call", namespace: "" }),
    { path: "node:sqlite", external: true },
  );
  assert.deepEqual(
    plugin.resolve({ path: "node:test", kind: "dynamic-import", namespace: "" }),
    { path: "node:test", external: true },
  );
  // Something that is not a built-in is left to the normal resolver.
  assert.equal(plugin.resolve({ path: "react", kind: "import-statement", namespace: "" }), undefined);
});

test("an import statement of a built-in binds to one shared wrapper per bundle", () => {
  const plugin = capture();
  assert.deepEqual(
    plugin.resolve({ path: "node:fs", kind: "import-statement", namespace: "" }),
    { path: "fs", namespace: "ade-shared-builtin" },
  );
  // The wrapper re-exports the module's live properties and requires it with
  // the prefix, as every importer used to do on its own.
  const loaded = plugin.load("fs");
  assert.match(loaded.contents, /export \* from "node:fs"/);
  assert.match(loaded.contents, /export default require\("node:fs"\)/);
});
