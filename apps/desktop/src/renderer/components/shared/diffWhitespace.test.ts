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

  it("keeps a whitespace-only pair as a context line beside a real change", () => {
    const patch = `${header}
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 2; 
-const c = 3;
+const c = 4;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -1,3 +1,3 @@
 const a = 1;
 const b = 2; 
-const c = 3;
+const c = 4;`);
  });

  it("keeps an unpaired real addition in place after a dropped whitespace pair", () => {
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
@@ -1,3 +1,4 @@
 const a = 1;
 const b = 2;
+const d = 4;
 const c = 3;`);
  });

  it("does not move an addition ahead of a line whose whitespace-only change was dropped", () => {
    // The trailing addition belongs after `line two`, and the whitespace-only
    // reindent of `line two` must remain as context so it stays there.
    const patch = `${header}
@@ -1,3 +1,4 @@
-line one
-  line two
-line three
+line one 
+    line two
+line three
+line four`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -1,3 +1,4 @@
 line one 
     line two
 line three
+line four`);
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

  it("keeps a leading whitespace-only pair as context without moving the hunk start", () => {
    // A leading whitespace-only change is not a real change, so the line stays
    // as context and the `@@` start is untouched — matching `git diff -w`.
    const patch = `${header}
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 1; 
-const b = 2;
+const b = 3;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -1,2 +1,2 @@
 const a = 1; 
-const b = 2;
+const b = 3;`);
  });

  it("drops a whitespace-only hunk but keeps a real hunk in the same file", () => {
    const patch = `${header}
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 1; 
 const b = 2;
@@ -10,2 +10,2 @@
 const c = 3;
-const d = 4;
+const d = 5;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -10,2 +10,2 @@
 const c = 3;
-const d = 4;
+const d = 5;`);
  });

  it("keeps the shared no-newline marker on a whitespace-only pair turned to context", () => {
    const patch = `${header}
@@ -1,2 +1,2 @@
-const b = 2;
-const a = 1;
\\ No newline at end of file
+const c = 2;
+const a = 1; 
\\ No newline at end of file`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(`${header}
@@ -1,2 +1,2 @@
-const b = 2;
+const c = 2;
 const a = 1; 
\\ No newline at end of file`);
  });

  it("keeps a pair whose two sides disagree on the no-newline marker", () => {
    // One context line cannot carry both newline states, so the pair stays a
    // change rather than being folded away.
    const patch = `${header}
@@ -1 +1 @@
-const a = 1;
\\ No newline at end of file
+const a = 1;`;
    const result = stripWhitespaceOnlyPatchChanges(patch);
    expect(result.whitespaceOnly).toBe(false);
    expect(result.patch).toBe(patch);
  });
});
