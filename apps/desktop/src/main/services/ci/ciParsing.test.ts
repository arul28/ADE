import { describe, expect, it } from "vitest";
import { chooseSuggestedCommand, computeCiScanDiff, hasShellMetacharacters, parseCommandLine } from "./ciParsing";

describe("ciParsing", () => {
  it("parses basic argv", () => {
    expect(parseCommandLine("npm test")).toEqual(["npm", "test"]);
  });

  it("parses quoted arguments", () => {
    expect(parseCommandLine('echo "a b"')).toEqual(["echo", "a b"]);
    expect(parseCommandLine("echo 'a b'")).toEqual(["echo", "a b"]);
  });

  it("parses escaped whitespace and quotes", () => {
    expect(parseCommandLine("echo a\\ b")).toEqual(["echo", "a b"]);
    expect(parseCommandLine('echo "a\\\"b"')).toEqual(["echo", 'a"b']);
  });

  it("throws on unclosed quotes", () => {
    expect(() => parseCommandLine("echo 'oops")).toThrow(/unclosed quote/i);
    expect(() => parseCommandLine('echo "oops')).toThrow(/unclosed quote/i);
  });

  it("detects shell metacharacters", () => {
    expect(hasShellMetacharacters("npm test")).toBe(false);
    expect(hasShellMetacharacters("npm test | tee out.txt")).toBe(true);
    expect(hasShellMetacharacters("echo hi && echo bye")).toBe(true);
    expect(hasShellMetacharacters("echo hi; echo bye")).toBe(true);
  });

  it("chooses an interesting command when available", () => {
    const warnings: string[] = [];
    const picked = chooseSuggestedCommand({ commands: ["echo hello", "npm test"], warnings });
    expect(picked.suggestedCommandLine).toBe("npm test");
    expect(picked.suggestedCommand).toEqual(["npm", "test"]);
    expect(warnings).toEqual([]);
  });

  it("falls back to the first parseable non-shell command", () => {
    const warnings: string[] = [];
    const picked = chooseSuggestedCommand({ commands: ["echo hello", "cat file.txt"], warnings });
    expect(picked.suggestedCommandLine).toBe("echo hello");
    expect(picked.suggestedCommand).toEqual(["echo", "hello"]);
    expect(warnings).toEqual([]);
  });

  it("skips shell pipelines and returns null when nothing is importable", () => {
    const warnings: string[] = [];
    const picked = chooseSuggestedCommand({ commands: ["npm test | tee out.txt"], warnings });
    expect(picked.suggestedCommandLine).toBe(null);
    expect(picked.suggestedCommand).toBe(null);
    expect(warnings).toEqual([]);
  });

  it("computes scan diffs", () => {
    const prev = { a: "1", b: "1" };
    const next = { b: "1", c: "2" };
    expect(computeCiScanDiff(prev, next)).toEqual({ added: 1, removed: 1, changed: 0, unchanged: 1 });
    expect(computeCiScanDiff({ a: "1" }, { a: "2" })).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
  });
});

