import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansiStrip";

describe("stripAnsi", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  it("removes CSI sequences that include private mode params", () => {
    expect(stripAnsi("a\u001b[?2026lb")).toBe("ab");
  });

  it("removes OSC sequences", () => {
    expect(stripAnsi("\u001b]0;title\u0007hello")).toBe("hello");
  });

  it("removes carriage returns", () => {
    expect(stripAnsi("a\rb")).toBe("ab");
  });

  it("applies backspaces", () => {
    expect(stripAnsi("abc\b\bde")).toBe("ade");
  });
});

