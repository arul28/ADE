import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testResetRipgrepExecFile,
  __testSetRipgrepExecFile,
  createGrepSearchTool,
} from "./grepSearch";

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
  __testResetRipgrepExecFile();
  vi.restoreAllMocks();
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

// Force JS fallback by making ripgrep's exec path reject (matches real "rg missing" behavior).
function forceJsFallback(): void {
  __testSetRipgrepExecFile(
    ((cmd: unknown, ...rest: unknown[]) => {
      if (cmd === "rg") {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") {
          process.nextTick(() => (cb as (err: Error) => void)(new Error("rg not available")));
          return;
        }
      }
      return (execFile as (typeof import("node:child_process"))["execFile"])(cmd as never, ...rest as never[]);
    }) as typeof execFile,
  );
}

describe("createGrepSearchTool", () => {
  // --------------------------------------------------------------------------
  // Happy paths (JS fallback — works regardless of rg installation)
  // --------------------------------------------------------------------------

  describe("JS fallback path", () => {
    it("finds a simple string pattern in files", async () => {
      const cwd = makeTmpDir("grep-simple-");
      writeFixtureFile(cwd, "hello.ts", "const greeting = 'hello world';");
      writeFixtureFile(cwd, "other.ts", "const x = 42;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "hello", context: 0 });

      expect(result.matchCount).toBe(1);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].content).toContain("hello world");
      expect(result.matches[0].line).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it("finds regex patterns like function declarations", async () => {
      const cwd = makeTmpDir("grep-regex-");
      writeFixtureFile(
        cwd,
        "utils.ts",
        [
          "function add(a: number, b: number) {",
          "  return a + b;",
          "}",
          "",
          "function multiply(a: number, b: number) {",
          "  return a * b;",
          "}",
        ].join("\n"),
      );
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "function\\s+\\w+", context: 0 });

      expect(result.matchCount).toBe(2);
      expect(result.matches[0].content).toContain("function add");
      expect(result.matches[1].content).toContain("function multiply");
    });

    it("filters by file glob", async () => {
      const cwd = makeTmpDir("grep-glob-");
      writeFixtureFile(cwd, "app.ts", "const value = 42;");
      writeFixtureFile(cwd, "app.js", "const value = 42;");
      writeFixtureFile(cwd, "readme.md", "value is 42");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "42", glob: "*.ts", context: 0 });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].displayPath).toBe("app.ts");
    });

    it("returns multiple matches across files", async () => {
      const cwd = makeTmpDir("grep-multi-");
      writeFixtureFile(cwd, "a.ts", "export const TOKEN = 'abc';");
      writeFixtureFile(cwd, "b.ts", "import { TOKEN } from './a';");
      writeFixtureFile(cwd, "c.ts", "// no match here");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "TOKEN", context: 0 });

      expect(result.matchCount).toBe(2);
      const displayPaths = result.matches.map((m: { displayPath: string }) => m.displayPath);
      expect(displayPaths).toContain("a.ts");
      expect(displayPaths).toContain("b.ts");
    });

    it("returns displayPath values relative to root", async () => {
      const cwd = makeTmpDir("grep-display-");
      writeFixtureFile(cwd, "src/deep/nested/file.ts", "const target = true;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "target", context: 0 });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].displayPath).toBe("src/deep/nested/file.ts");
      expect(result.matches[0].path.startsWith(fs.realpathSync(cwd))).toBe(true);
    });

    it("returns line numbers for each match", async () => {
      const cwd = makeTmpDir("grep-lines-");
      writeFixtureFile(
        cwd,
        "code.ts",
        ["line one", "line two", "target here", "line four", "target again"].join("\n"),
      );
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "target", context: 0 });

      expect(result.matchCount).toBe(2);
      expect(result.matches[0].line).toBe(3);
      expect(result.matches[1].line).toBe(5);
    });

    it("scopes search to a subdirectory via the path parameter", async () => {
      const cwd = makeTmpDir("grep-subdir-");
      writeFixtureFile(cwd, "src/app.ts", "const value = 1;");
      writeFixtureFile(cwd, "lib/util.ts", "const value = 2;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "value", path: "src", context: 0 });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].displayPath).toBe("src/app.ts");
    });

    it("searches a single file when path points to a file", async () => {
      const cwd = makeTmpDir("grep-singlefile-");
      writeFixtureFile(cwd, "target.ts", "const x = 1;\nconst y = 2;");
      writeFixtureFile(cwd, "other.ts", "const x = 3;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "const", path: "target.ts", context: 0 });

      expect(result.matchCount).toBe(2);
      // All matches should be from target.ts only
      for (const match of result.matches) {
        expect(match.displayPath).toBe("target.ts");
      }
    });

    it("skips node_modules, .git, dist, build, .next, coverage", async () => {
      const cwd = makeTmpDir("grep-skip-");
      writeFixtureFile(cwd, "src/app.ts", "const marker = true;");
      writeFixtureFile(cwd, "node_modules/pkg/index.ts", "const marker = true;");
      writeFixtureFile(cwd, ".git/objects.ts", "const marker = true;");
      writeFixtureFile(cwd, "dist/bundle.ts", "const marker = true;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "marker", context: 0 });

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].displayPath).toBe("src/app.ts");
    });

    it("repo-wide JS fallback skips root .ade but still searches .github", async () => {
      const cwd = makeTmpDir("grep-hidden-root-");
      writeFixtureFile(cwd, ".ade/secrets.txt", "SECRET_MARKER");
      writeFixtureFile(cwd, ".github/workflows/ci.yml", "SECRET_MARKER");
      writeFixtureFile(cwd, "src/app.ts", "SECRET_MARKER");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "SECRET_MARKER", context: 0 });
      const paths = result.matches.map((m) => m.displayPath).sort();
      expect(paths).toEqual([".github/workflows/ci.yml", "src/app.ts"]);
    });

    it("handles brace expansion in file glob: *.{ts,tsx}", async () => {
      const cwd = makeTmpDir("grep-brace-");
      writeFixtureFile(cwd, "app.ts", "const val = 1;");
      writeFixtureFile(cwd, "comp.tsx", "const val = 2;");
      writeFixtureFile(cwd, "style.css", "const val = 3;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "val", glob: "*.{ts,tsx}", context: 0 });

      expect(result.matchCount).toBe(2);
      const paths = result.matches.map((m: { displayPath: string }) => m.displayPath).sort();
      expect(paths).toEqual(["app.ts", "comp.tsx"]);
    });

    it("returns empty results when pattern has no matches", async () => {
      const cwd = makeTmpDir("grep-nomatch-");
      writeFixtureFile(cwd, "code.ts", "const x = 1;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "nonexistent_string_xyz", context: 0 });

      expect(result.matchCount).toBe(0);
      expect(result.matches).toEqual([]);
      expect(result.error).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Error paths
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns error when path is outside the repo root", async () => {
      const cwd = makeTmpDir("grep-escape-");

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "test", path: "/tmp", context: 0 });

      expect(result.error).toBeDefined();
      expect(result.error).toContain("outside the repo root");
      expect(result.matchCount).toBe(0);
    });

    it("returns error when path does not exist", async () => {
      const cwd = makeTmpDir("grep-noexist-");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "test", path: "nonexistent", context: 0 });

      expect(result.error).toBeDefined();
      expect(result.matchCount).toBe(0);
    });

    it("surfaces a descriptive 'Invalid regex pattern' error for malformed patterns (JS fallback)", async () => {
      const cwd = makeTmpDir("grep-bad-regex-");
      writeFixtureFile(cwd, "code.ts", "const x = 1;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      // Unmatched `[` — a SyntaxError from `new RegExp`.
      const result = await tool.execute({ pattern: "[", context: 0 });

      expect(result.matchCount).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Invalid regex pattern");
    });
  });

  // --------------------------------------------------------------------------
  // Glob edge cases
  // --------------------------------------------------------------------------

  describe("glob handling", () => {
    it("matches bare filenames under a **/*.ts glob (JS fallback)", async () => {
      const cwd = makeTmpDir("grep-starstar-");
      writeFixtureFile(cwd, "foo.ts", "const marker = 1;");
      writeFixtureFile(cwd, "src/bar.ts", "const marker = 2;");
      writeFixtureFile(cwd, "readme.md", "marker");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "marker", glob: "**/*.ts", context: 0 });

      const paths = result.matches.map((m) => m.displayPath).sort();
      expect(paths).toEqual(["foo.ts", "src/bar.ts"]);
    });

    it("preserves directory components in JS fallback globs", async () => {
      const cwd = makeTmpDir("grep-dir-glob-");
      writeFixtureFile(cwd, "src/app.ts", "const marker = 1;");
      writeFixtureFile(cwd, "src/deep/app.ts", "const marker = 2;");
      writeFixtureFile(cwd, "lib/app.ts", "const marker = 3;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "marker", glob: "src/*.ts", context: 0 });

      const paths = result.matches.map((m) => m.displayPath).sort();
      expect(paths).toEqual(["src/app.ts"]);
    });

    it("matches directory ** globs without escaping the subtree", async () => {
      const cwd = makeTmpDir("grep-dir-starstar-");
      writeFixtureFile(cwd, "services/index.ts", "const marker = 1;");
      writeFixtureFile(cwd, "services/api/handler.ts", "const marker = 2;");
      writeFixtureFile(cwd, "packages/services/index.ts", "const marker = 3;");
      forceJsFallback();

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "marker", glob: "services/**/*.ts", context: 0 });

      const paths = result.matches.map((m) => m.displayPath).sort();
      expect(paths).toEqual(["services/api/handler.ts", "services/index.ts"]);
    });
  });

  // --------------------------------------------------------------------------
  // Ripgrep path (only if rg is installed)
  // --------------------------------------------------------------------------

  describe("ripgrep path (integration)", () => {
    it("finds matches using ripgrep when available", async () => {
      const cwd = makeTmpDir("grep-rg-");
      writeFixtureFile(cwd, "hello.ts", "const greeting = 'hello world';");

      const tool = createGrepSearchTool(cwd);
      const result = await tool.execute({ pattern: "hello", context: 0 });

      // Whether rg is installed or not, we should get results
      expect(result.matchCount).toBe(1);
      expect(result.matches[0].content).toContain("hello world");
    });
  });
});
