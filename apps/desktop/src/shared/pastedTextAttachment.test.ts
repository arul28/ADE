import { describe, expect, it } from "vitest";
import {
  PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE,
  PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE,
  pastedTextChipLabel,
  pastedTextFilename,
  pastedTextLineCount,
  shouldPasteTextAsFile,
  sniffPastedTextExtension,
} from "./pastedTextAttachment";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");

describe("shouldPasteTextAsFile", () => {
  it("leaves small pastes alone", () => {
    expect(shouldPasteTextAsFile("")).toBe(false);
    expect(shouldPasteTextAsFile("a short paste")).toBe(false);
  });

  it("folds only pastes over the character threshold", () => {
    expect(shouldPasteTextAsFile("x".repeat(PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE))).toBe(false);
    expect(shouldPasteTextAsFile("x".repeat(PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE + 1))).toBe(true);
  });

  it("folds only pastes over the line threshold", () => {
    expect(shouldPasteTextAsFile(lines(PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE))).toBe(false);
    expect(shouldPasteTextAsFile(lines(PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE + 1))).toBe(true);
  });

  it("counts CRLF, a lone CR, and a trailing newline the same as LF", () => {
    const fortLines = lines(PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE);
    expect(shouldPasteTextAsFile(fortLines.replace(/\n/g, "\r\n"))).toBe(false);
    expect(shouldPasteTextAsFile(fortLines.replace(/\n/g, "\r"))).toBe(false);
    // The trailing newline ends the last line; it does not open a new one.
    expect(shouldPasteTextAsFile(`${fortLines}\n`)).toBe(false);
    // A real extra line still folds.
    expect(shouldPasteTextAsFile(`${fortLines}\nlast`)).toBe(true);
  });
});

describe("pastedTextLineCount", () => {
  it("counts the lines a person sees", () => {
    expect(pastedTextLineCount("")).toBe(0);
    expect(pastedTextLineCount("a")).toBe(1);
    expect(pastedTextLineCount("a\n")).toBe(1);
    expect(pastedTextLineCount("a\r\nb")).toBe(2);
    expect(pastedTextLineCount("a\rb")).toBe(2);
  });
});

describe("sniffPastedTextExtension", () => {
  it.each([
    ["a git diff", "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@", ".diff"],
    ["a unified diff without the `diff --git` header", "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new", ".diff"],
    ["a JSON object", '{"a": 1, "b": [2, 3]}', ".json"],
    ["a JSON array", "[\n  1,\n  2\n]", ".json"],
    ["a timestamped log", "2026-10-16 02:00:01 starting\n2026-10-16 02:00:02 working\n2026-10-16 02:00:03 done", ".log"],
    ["a levelled log", "INFO boot\nWARN slow\nERROR boom", ".log"],
    ["anything else", "just some notes about the thing\nand a second line", ".txt"],
    // A near-miss must not guess: a false `.json` reads worse than an honest `.txt`.
    ["text that only starts like JSON", "{ this is not json at all\n nor is this", ".txt"],
    ["prose that mentions a diff", "the diff --git output was confusing", ".txt"],
  ])("names %s", (_label, text, expected) => {
    expect(sniffPastedTextExtension(text)).toBe(expected);
  });
});

describe("pastedTextFilename", () => {
  it("carries the epoch milliseconds and the sniffed extension", () => {
    expect(pastedTextFilename("diff --git a/x b/x", 1792109142144)).toBe("pasted-1792109142144.diff");
    expect(pastedTextFilename("plain notes", 42)).toBe("pasted-42.txt");
  });
});

describe("pastedTextChipLabel", () => {
  it("reads the line count with the right plural", () => {
    expect(pastedTextChipLabel(1)).toBe("Pasted · 1 line");
    expect(pastedTextChipLabel(212)).toBe("Pasted · 212 lines");
  });
});
