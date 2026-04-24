import { describe, expect, it } from "vitest";
import { buildDiffContextForFinding } from "./reviewDiffContext";

const SAMPLE_PATCH = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,10 @@
 function validateToken(token: string) {
   if (!token) return false;
-  return token === SECRET;
+  if (token.length < 8) return false;
+  return verifySignature(token);
+}
+function verifySignature(token: string) {
+  return cryptoCompare(token, SECRET);
 }`;

describe("buildDiffContextForFinding", () => {
  it("returns null when file path is missing", () => {
    expect(buildDiffContextForFinding({ filePath: null, anchoredLine: 12, patches: [] })).toBeNull();
  });

  it("returns null when no patch matches the file", () => {
    const result = buildDiffContextForFinding({
      filePath: "src/other.ts",
      anchoredLine: 10,
      patches: [{ filePath: "src/auth.ts", excerpt: SAMPLE_PATCH }],
    });
    expect(result).toBeNull();
  });

  it("highlights the anchored line and slices window around it", () => {
    const result = buildDiffContextForFinding({
      filePath: "src/auth.ts",
      anchoredLine: 13,
      patches: [{ filePath: "src/auth.ts", excerpt: SAMPLE_PATCH }],
    });
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("src/auth.ts");
    expect(result!.anchoredLine).toBe(13);
    const highlighted = result!.lines.filter((line) => line.highlighted);
    expect(highlighted.length).toBe(1);
    expect(highlighted[0]?.line).toBe(13);
    expect(result!.lines.some((line) => line.kind === "add")).toBe(true);
  });

  it("falls back to the first hunk when no anchor is provided", () => {
    const result = buildDiffContextForFinding({
      filePath: "src/auth.ts",
      anchoredLine: null,
      patches: [{ filePath: "src/auth.ts", excerpt: SAMPLE_PATCH }],
    });
    expect(result).not.toBeNull();
    expect(result!.lines.length).toBeGreaterThan(0);
    expect(result!.lines.find((line) => line.highlighted)).toBeUndefined();
  });
});
