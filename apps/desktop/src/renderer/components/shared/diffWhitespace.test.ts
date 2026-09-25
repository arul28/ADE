import { describe, expect, it } from "vitest";

import {
  isWhitespaceOnlyTextDiff,
  stripWhitespaceOnlyPatchChanges,
} from "./diffWhitespace";

describe("isWhitespaceOnlyTextDiff", () => {
  it.each([
    ["reindentation only", "  const a = 1;\n", "    const a = 1;\n"],
    ["tabs vs spaces", "const a = 1;\n", "\tconst a = 1;\n"],
    ["trailing whitespace", "const a = 1;\n", "const a = 1;   \n"],
    ["CRLF vs LF", "const a = 1;\r\nconst b = 2;\r\n", "const a = 1;\nconst b = 2;\n"],
    ["trailing newline", "const a = 1;", "const a = 1;\n"],
    ["blank vs spaces-only line", "a\n\nb\n", "a\n   \nb\n"],
  ])("treats %s as whitespace-only", (_label, oldText, newText) => {
    expect(isWhitespaceOnlyTextDiff(oldText, newText)).toBe(true);
  });

  it("is false for a real content change", () => {
    expect(isWhitespaceOnlyTextDiff("const a = 1;\n", "const a = 2;\n")).toBe(false);
  });

  it("is false when internal whitespace changes", () => {
    expect(isWhitespaceOnlyTextDiff("const a = 1;\n", "const  a = 1;\n")).toBe(false);
  });

  it("is false when a line is added", () => {
    expect(isWhitespaceOnlyTextDiff("a\nb\n", "a\nb\nc\n")).toBe(false);
  });
});

describe("stripWhitespaceOnlyPatchChanges", () => {
  const header = [
    "diff --git a/foo.ts b/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
  ].join("\n");

  it("drops a hunk whose only change is whitespace and flags the file whitespace-only", () => {
    const patch = `${header}
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 2;   
 const c = 3;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(true);
    expect(result.patch).toBe("");
  });

  it("keeps a real change and removes a whitespace-only pair beside it", () => {
    const patch = `${header}
@@ -1,4 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 2; 
-const c = 3;
+const c = 4;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -1,2 +1,2 @@
 const a = 1;
-const c = 3;
+const c = 4;`);
  });

  it("keeps an unpaired real addition after dropping a whitespace pair", () => {
    const patch = `${header}
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 2;
+const d = 4;
 const c = 3;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -1,2 +1,3 @@
 const a = 1;
+const d = 4;
 const c = 3;`);
  });

  it("reindentation-only hunk is dropped", () => {
    const patch = `${header}
@@ -1,2 +1,2 @@
-    const a = 1;
+  const a = 1;
 const b = 2;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(true);
  });

  it("returns the patch unchanged when there are no hunks", () => {
    const patch = `${header}`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(patch);
  });
});
