import { describe, expect, it } from "vitest";
import {
  PASTE_FOLD_CHAR_THRESHOLD,
  PASTE_FOLD_LINE_THRESHOLD,
  PASTED_TEXT_ATTACHMENT_FILENAME,
  pastedTextAttachmentFile,
  shouldFoldPastedText,
} from "./composerPasteFolding";

describe("shouldFoldPastedText", () => {
  it("leaves empty and missing pastes on the native path", () => {
    expect(shouldFoldPastedText("")).toBe(false);
    expect(shouldFoldPastedText(null)).toBe(false);
    expect(shouldFoldPastedText(undefined)).toBe(false);
  });

  it("folds only pastes over the character threshold", () => {
    expect(shouldFoldPastedText("x".repeat(PASTE_FOLD_CHAR_THRESHOLD))).toBe(false);
    expect(shouldFoldPastedText("x".repeat(PASTE_FOLD_CHAR_THRESHOLD + 1))).toBe(true);
  });

  it("folds only pastes over the line threshold", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
    expect(shouldFoldPastedText(lines(PASTE_FOLD_LINE_THRESHOLD))).toBe(false);
    expect(shouldFoldPastedText(lines(PASTE_FOLD_LINE_THRESHOLD + 1))).toBe(true);
  });

  it("counts CRLF, lone CR, and trailing newlines the same as LF", () => {
    const twentyLines = Array.from({ length: 20 }, () => "x").join("\n");
    expect(shouldFoldPastedText(twentyLines.replace(/\n/g, "\r\n"))).toBe(false);
    expect(shouldFoldPastedText(twentyLines.replace(/\n/g, "\r"))).toBe(false);
    // A single trailing newline does not add a twenty-first line.
    expect(shouldFoldPastedText(`${twentyLines}\n`)).toBe(false);
    // A real twenty-first line still folds.
    expect(shouldFoldPastedText(`${twentyLines}\nlast`)).toBe(true);
  });

  it("folds multi-byte text by its code-unit length, like every other boundary", () => {
    // 1001 emoji are 2002 UTF-16 units, over the 2000 char threshold.
    expect(shouldFoldPastedText("😀".repeat(1_001))).toBe(true);
    expect(shouldFoldPastedText("😀".repeat(1_000))).toBe(false);
  });
});

describe("pastedTextAttachmentFile", () => {
  it("stages the exact pasted text as a named plain-text file", async () => {
    const text = "line one\r\nline two\n";
    const file = pastedTextAttachmentFile(text);
    expect(file.name).toBe(PASTED_TEXT_ATTACHMENT_FILENAME);
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe(text);
  });
});
