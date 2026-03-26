import { describe, expect, it } from "vitest";
import { clusterFiles } from "./humanWorkDigestService";

describe("clusterFiles", () => {
  it("groups files by their top-level directory", () => {
    const result = clusterFiles([
      "src/main/app.ts",
      "src/renderer/index.tsx",
      "docs/README.md",
    ]);
    expect(result).toEqual([
      {
        label: "src",
        files: ["src/main/app.ts", "src/renderer/index.tsx"],
        summary: "2 file(s) touched under src.",
      },
      {
        label: "docs",
        files: ["docs/README.md"],
        summary: "1 file(s) touched under docs.",
      },
    ]);
  });

  it("assigns files without a path separator to the 'root' bucket", () => {
    const result = clusterFiles(["package.json", ".gitignore", "tsconfig.json"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      label: "root",
      files: ["package.json", ".gitignore", "tsconfig.json"],
      summary: "3 file(s) touched under root.",
    });
  });

  it("returns empty array for empty input", () => {
    expect(clusterFiles([])).toEqual([]);
  });

  it("skips blank and whitespace-only entries", () => {
    const result = clusterFiles(["src/a.ts", "", "  ", "src/b.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("trims whitespace from file paths", () => {
    const result = clusterFiles(["  src/a.ts  ", "  docs/b.md  "]);
    // Alphabetical tie-break: docs before src
    expect(result[0]!.files[0]).toBe("docs/b.md");
    expect(result[1]!.files[0]).toBe("src/a.ts");
  });

  it("sorts clusters by count descending, then label alphabetically", () => {
    const result = clusterFiles([
      "apps/desktop/main.ts",
      "apps/desktop/renderer.ts",
      "apps/desktop/preload.ts",
      "docs/README.md",
      "lib/utils.ts",
      "lib/helpers.ts",
    ]);
    expect(result.map((c) => c.label)).toEqual(["apps", "lib", "docs"]);
    expect(result[0]!.files).toHaveLength(3);
    expect(result[1]!.files).toHaveLength(2);
    expect(result[2]!.files).toHaveLength(1);
  });

  it("breaks count ties with alphabetical label order", () => {
    const result = clusterFiles([
      "zeta/a.ts",
      "alpha/b.ts",
    ]);
    // Both have count 1, so should be sorted alphabetically
    expect(result.map((c) => c.label)).toEqual(["alpha", "zeta"]);
  });

  it("handles mixed root and nested files", () => {
    const result = clusterFiles([
      "package.json",
      "src/main.ts",
      "README.md",
      "src/lib/utils.ts",
    ]);
    const labels = result.map((c) => c.label);
    expect(labels).toContain("root");
    expect(labels).toContain("src");
    const rootCluster = result.find((c) => c.label === "root")!;
    expect(rootCluster.files).toEqual(["package.json", "README.md"]);
  });

  it("generates the correct summary text", () => {
    const result = clusterFiles(["a/one.ts", "a/two.ts", "a/three.ts"]);
    expect(result[0]!.summary).toBe("3 file(s) touched under a.");
  });

  it("handles a single file", () => {
    const result = clusterFiles(["src/index.ts"]);
    expect(result).toEqual([
      {
        label: "src",
        files: ["src/index.ts"],
        summary: "1 file(s) touched under src.",
      },
    ]);
  });

  it("handles deeply nested paths using only the first segment", () => {
    const result = clusterFiles([
      "apps/desktop/src/main/services/chat/foo.ts",
      "apps/web/src/index.ts",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("apps");
    expect(result[0]!.files).toHaveLength(2);
  });
});
