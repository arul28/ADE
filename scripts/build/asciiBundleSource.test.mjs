import assert from "node:assert/strict";
import { test } from "node:test";
import { asciiBundleSource } from "./asciiBundleSource.ts";

// The plugin's map is the bundle's final map: tsup's own composition matched
// the chunk by a path that source-map lowercases on Windows, so a map that
// relied on it pointed every frame back at the bundle itself.
test("the escaped chunk's map keeps esbuild's sources and moves columns past each escape", () => {
  // Two calls on one line; the second follows a one-character string that grows by five columns.
  const code = "a('é');b();\nc();\n";
  const esbuildMap = {
    version: 3,
    sources: ["../src/in.ts"],
    sourcesContent: ["a('é');\nb();\nc();\n"],
    names: [],
    // a() at 0 -> in.ts 1:0; b() at 7 -> in.ts 2:0; c() at line 2 col 0 -> in.ts 3:0.
    mappings: "AAAA,OACA;AACA",
  };
  for (const chunkPath of ["D:\\a\\ADE\\apps\\ade-cli\\dist\\cli.cjs", "/home/runner/work/ADE/apps/ade-cli/dist/cli.cjs"]) {
    const result = asciiBundleSource().renderChunk(code, { path: chunkPath, map: JSON.stringify(esbuildMap) });
    assert.equal(result.code, "a('\\u00e9');b();\nc();\n");
    assert.deepEqual(result.map.sources, ["../src/in.ts"], chunkPath);
    assert.deepEqual(result.map.sourcesContent, esbuildMap.sourcesContent);
    // b() now starts at column 12; c() on the line without escapes is untouched.
    assert.equal(result.map.mappings, "AAAA,YACA;AACA");
  }
});
