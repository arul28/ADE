import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadFileRangeTool } from "./readFileRange";

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

const FIVE_LINES = ["line one", "line two", "line three", "line four", "line five"].join("\n");

describe("createReadFileRangeTool", () => {
  // --------------------------------------------------------------------------
  // Happy paths
  // --------------------------------------------------------------------------

  it("reads an entire file when no offset or limit is given", async () => {
    const cwd = makeTmpDir("read-full-");
    writeFixtureFile(cwd, "sample.ts", FIVE_LINES);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "sample.ts" });

    expect(result.error).toBeUndefined();
    expect(result.totalLines).toBe(5);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(5);
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line five");
  });

  it("reads from an offset", async () => {
    const cwd = makeTmpDir("read-offset-");
    writeFixtureFile(cwd, "sample.ts", FIVE_LINES);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "sample.ts", offset: 3 });

    expect(result.error).toBeUndefined();
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(5);
    expect(result.content).toContain("line three");
    expect(result.content).toContain("line five");
    expect(result.content).not.toContain("line one");
    expect(result.content).not.toContain("line two");
  });

  it("reads with a limit", async () => {
    const cwd = makeTmpDir("read-limit-");
    writeFixtureFile(cwd, "sample.ts", FIVE_LINES);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "sample.ts", limit: 2 });

    expect(result.error).toBeUndefined();
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(2);
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line two");
    expect(result.content).not.toContain("line three");
  });

  it("reads with both offset and limit", async () => {
    const cwd = makeTmpDir("read-offset-limit-");
    writeFixtureFile(cwd, "sample.ts", FIVE_LINES);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "sample.ts", offset: 2, limit: 2 });

    expect(result.error).toBeUndefined();
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.content).toContain("line two");
    expect(result.content).toContain("line three");
    expect(result.content).not.toContain("line one");
    expect(result.content).not.toContain("line four");
  });

  it("clamps limit when it exceeds total lines", async () => {
    const cwd = makeTmpDir("read-clamp-");
    writeFixtureFile(cwd, "sample.ts", FIVE_LINES);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "sample.ts", offset: 4, limit: 100 });

    expect(result.error).toBeUndefined();
    expect(result.startLine).toBe(4);
    expect(result.endLine).toBe(5);
    expect(result.totalLines).toBe(5);
  });

  it("formats lines with padded line numbers and tab", async () => {
    const cwd = makeTmpDir("read-format-");
    writeFixtureFile(cwd, "sample.ts", FIVE_LINES);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "sample.ts", limit: 1 });

    // Line number format: 6-char padded number + tab + content
    // "     1\tline one"
    expect(result.content).toMatch(/^\s+1\tline one$/);
  });

  it("returns displayPath relative to root", async () => {
    const cwd = makeTmpDir("read-displaypath-");
    writeFixtureFile(cwd, "src/deep/file.ts", "content");

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "src/deep/file.ts" });

    expect(result.error).toBeUndefined();
    expect(result.displayPath).toBe("src/deep/file.ts");
    expect(result.path).toBeDefined();
    expect(result.path!.startsWith(fs.realpathSync(cwd))).toBe(true);
  });

  it("accepts absolute paths within the root", async () => {
    const cwd = makeTmpDir("read-abs-");
    writeFixtureFile(cwd, "file.ts", "absolute path test");
    const absPath = path.join(cwd, "file.ts");

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: absPath });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("absolute path test");
  });

  it("reports totalLines accurately", async () => {
    const cwd = makeTmpDir("read-total-");
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFixtureFile(cwd, "big.ts", content);

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "big.ts" });

    expect(result.totalLines).toBe(100);
  });

  // --------------------------------------------------------------------------
  // Error paths
  // --------------------------------------------------------------------------

  it("returns file not found error for non-existent file", async () => {
    const cwd = makeTmpDir("read-notfound-");

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "nope.ts" });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("File not found");
    expect(result.totalLines).toBe(0);
  });

  it("returns error when path is outside the repo root", async () => {
    const cwd = makeTmpDir("read-escape-");

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "/etc/passwd" });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("outside the repo root");
    expect(result.totalLines).toBe(0);
  });

  it("returns error for path traversal attempts", async () => {
    const cwd = makeTmpDir("read-traversal-");
    writeFixtureFile(cwd, "inside.ts", "safe");

    const tool = createReadFileRangeTool(cwd);
    const result = await tool.execute({ file_path: "../../../etc/passwd" });

    expect(result.error).toBeDefined();
    expect(result.totalLines).toBe(0);
  });
});
