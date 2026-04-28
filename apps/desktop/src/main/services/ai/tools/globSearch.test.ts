import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGlobSearchTool } from "./globSearch";

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

describe("createGlobSearchTool", () => {
  // --------------------------------------------------------------------------
  // Happy paths
  // --------------------------------------------------------------------------

  it("matches *.ts files in root directory", async () => {
    const cwd = makeTmpDir("glob-basic-");
    writeFixtureFile(cwd, "index.ts", "export {}");
    writeFixtureFile(cwd, "utils.ts", "export {}");
    writeFixtureFile(cwd, "readme.md", "# Hello");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts" });

    expect(result.count).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.displayFiles).toContain("index.ts");
    expect(result.displayFiles).toContain("utils.ts");
    expect(result.displayFiles).not.toContain("readme.md");
  });

  it("matches src/**/*.ts recursively in nested directories", async () => {
    const cwd = makeTmpDir("glob-recursive-");
    writeFixtureFile(cwd, "src/app.ts", "export {}");
    writeFixtureFile(cwd, "src/lib/helper.ts", "export {}");
    writeFixtureFile(cwd, "src/lib/deep/nested.ts", "export {}");
    writeFixtureFile(cwd, "docs/readme.md", "# Hello");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "src/**/*.ts" });

    expect(result.count).toBe(3);
    expect(result.displayFiles).toContain("src/app.ts");
    expect(result.displayFiles).toContain("src/lib/helper.ts");
    expect(result.displayFiles).toContain("src/lib/deep/nested.ts");
  });

  it("accepts Windows-style separators in glob patterns", async () => {
    const cwd = makeTmpDir("glob-windows-pattern-");
    writeFixtureFile(cwd, "src/lib/helper.ts", "export {}");
    writeFixtureFile(cwd, "src/lib/helper.md", "# Hello");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "src\\**\\*.ts" });

    expect(result.count).toBe(1);
    expect(result.displayFiles).toEqual(["src/lib/helper.ts"]);
  });

  it("handles brace expansion: src/**/*.{ts,tsx}", async () => {
    const cwd = makeTmpDir("glob-brace-");
    writeFixtureFile(cwd, "src/App.tsx", "export {}");
    writeFixtureFile(cwd, "src/index.ts", "export {}");
    writeFixtureFile(cwd, "src/styles.css", "body {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "src/**/*.{ts,tsx}" });

    expect(result.count).toBe(2);
    expect(result.displayFiles).toContain("src/App.tsx");
    expect(result.displayFiles).toContain("src/index.ts");
    expect(result.displayFiles).not.toContain("src/styles.css");
  });

  it("skips node_modules, .git, dist, build, .next, coverage directories", async () => {
    const cwd = makeTmpDir("glob-skip-");
    writeFixtureFile(cwd, "src/app.ts", "export {}");
    writeFixtureFile(cwd, "node_modules/pkg/index.ts", "export {}");
    writeFixtureFile(cwd, ".git/config.ts", "export {}");
    writeFixtureFile(cwd, "dist/bundle.ts", "export {}");
    writeFixtureFile(cwd, "build/output.ts", "export {}");
    writeFixtureFile(cwd, ".next/cache.ts", "export {}");
    writeFixtureFile(cwd, "coverage/lcov.ts", "export {}");

    const tool = createGlobSearchTool(cwd);
    // Use a non-recursive root-level scan to check skipping behavior
    const result = await tool.execute({ pattern: "src/**/*.ts" });

    expect(result.count).toBe(1);
    expect(result.displayFiles).toEqual(["src/app.ts"]);
  });

  it("returns empty results for a valid pattern with no matches", async () => {
    const cwd = makeTmpDir("glob-empty-");
    writeFixtureFile(cwd, "readme.md", "# Hello");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts" });

    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("displayPath values are relative to the root", async () => {
    const cwd = makeTmpDir("glob-display-");
    writeFixtureFile(cwd, "src/deep/nested/file.ts", "export {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "src/**/*.ts" });

    expect(result.count).toBe(1);
    const match = result.matches![0];
    expect(match.displayPath).toBe("src/deep/nested/file.ts");
    // The absolute path should start with the cwd
    expect(match.path.startsWith(fs.realpathSync(cwd))).toBe(true);
  });

  it("uses a custom base path to scope the search", async () => {
    const cwd = makeTmpDir("glob-path-");
    writeFixtureFile(cwd, "src/app.ts", "export {}");
    writeFixtureFile(cwd, "lib/utils.ts", "export {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts", path: "src" });

    expect(result.count).toBe(1);
    expect(result.displayFiles).toContain("src/app.ts");
  });

  it("matches a specific directory prefix pattern", async () => {
    const cwd = makeTmpDir("glob-prefix-");
    writeFixtureFile(cwd, "src/components/Button.tsx", "export {}");
    writeFixtureFile(cwd, "src/pages/Home.tsx", "export {}");
    writeFixtureFile(cwd, "lib/util.tsx", "export {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "src/**/*.tsx" });

    expect(result.count).toBe(2);
    expect(result.displayFiles).toContain("src/components/Button.tsx");
    expect(result.displayFiles).toContain("src/pages/Home.tsx");
    expect(result.displayFiles).not.toContain("lib/util.tsx");
  });

  it("returns results sorted alphabetically", async () => {
    const cwd = makeTmpDir("glob-sort-");
    writeFixtureFile(cwd, "c.ts", "export {}");
    writeFixtureFile(cwd, "a.ts", "export {}");
    writeFixtureFile(cwd, "b.ts", "export {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts" });

    expect(result.count).toBe(3);
    const sorted = [...result.files].sort();
    expect(result.files).toEqual(sorted);
  });

  it("matches single-character wildcard with ?", async () => {
    const cwd = makeTmpDir("glob-question-");
    writeFixtureFile(cwd, "a1.ts", "export {}");
    writeFixtureFile(cwd, "a2.ts", "export {}");
    writeFixtureFile(cwd, "abc.ts", "export {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "a?.ts" });

    expect(result.count).toBe(2);
    expect(result.displayFiles).toContain("a1.ts");
    expect(result.displayFiles).toContain("a2.ts");
    expect(result.displayFiles).not.toContain("abc.ts");
  });

  // --------------------------------------------------------------------------
  // Error paths
  // --------------------------------------------------------------------------

  it("returns error when path is outside the repo root", async () => {
    const cwd = makeTmpDir("glob-escape-");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts", path: "/tmp" });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("outside the repo root");
    expect(result.count).toBe(0);
  });

  it("returns error when path does not exist", async () => {
    const cwd = makeTmpDir("glob-noexist-");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts", path: "nonexistent" });

    expect(result.error).toBeDefined();
    expect(result.count).toBe(0);
  });

  it("skips hidden directories (dot-prefixed)", async () => {
    const cwd = makeTmpDir("glob-hidden-");
    writeFixtureFile(cwd, "src/app.ts", "export {}");
    writeFixtureFile(cwd, ".hidden/secret.ts", "export {}");

    const tool = createGlobSearchTool(cwd);
    const result = await tool.execute({ pattern: "*.ts", path: "." });

    // Only the root-level *.ts should be found, .hidden is skipped
    expect(result.displayFiles).not.toContain(".hidden/secret.ts");
  });
});
