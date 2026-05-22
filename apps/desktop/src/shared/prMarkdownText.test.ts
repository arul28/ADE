import { describe, expect, it } from "vitest";

import { normalizeEscapedMarkdownNewlines } from "./prMarkdownText";

describe("normalizeEscapedMarkdownNewlines", () => {
  it("converts literal \\n sequences to real newlines", () => {
    const input = "## Summary\\n- tighten PR snapshot routing\\n- add lane delete cleanup";
    expect(normalizeEscapedMarkdownNewlines(input)).toBe(
      "## Summary\n- tighten PR snapshot routing\n- add lane delete cleanup",
    );
  });

  it("leaves strings with real newlines unchanged", () => {
    const input = "## Summary\n\n- item one\n- item two";
    expect(normalizeEscapedMarkdownNewlines(input)).toBe(input);
  });

  it("is a no-op when no backslashes are present", () => {
    const input = "plain text without escapes";
    expect(normalizeEscapedMarkdownNewlines(input)).toBe(input);
  });
});
