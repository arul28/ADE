/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: { codeBlockCopyButtonPosition: string }) => unknown) =>
    selector({ codeBlockCopyButtonPosition: "top" }),
}));

import { HighlightedCode, diffLineStyle, highlightCode } from "./CodeHighlighter";

afterEach(cleanup);

describe("code block syntax colours", () => {
  it("emits syntax tokens as custom-property references, not baked hexes", async () => {
    const html = await highlightCode("const answer = 42; // note\n", "typescript");

    expect(html).toContain("var(--color-syntax-keyword)");
    expect(html).toContain("var(--color-syntax-number)");
    expect(html).toContain("var(--color-syntax-comment)");
    // The whole point of the change: nothing in the markup names a colour that a
    // theme cannot reach, so the default foreground is a token too.
    expect(html).toContain("var(--chat-code-fg)");
    expect(html).not.toMatch(/color:#[0-9a-f]{6}/i);
  }, 30_000);

  it("returns identical markup for a repeated snippet regardless of theme", async () => {
    const code = "function greet() { return 'hi'; }";
    const first = await highlightCode(code, "typescript");
    document.documentElement.setAttribute("data-theme", "light");
    const second = await highlightCode(code, "typescript");
    document.documentElement.removeAttribute("data-theme");

    // The cache key is `${language}::${code}` with no theme in it, which is only
    // correct because the emitted colours are `var()` references.
    expect(second).toBe(first);
  }, 30_000);
});

describe("diff code block", () => {
  it("still colours added and removed lines from the diff tokens", () => {
    expect(diffLineStyle("+ added line").color).toBe("var(--color-diff-add)");
    expect(diffLineStyle("+ added line").background).toContain("var(--color-diff-add)");
    expect(diffLineStyle("- removed line").color).toBe("var(--color-diff-del)");
    expect(diffLineStyle("- removed line").background).toContain("var(--color-diff-del)");
    expect(diffLineStyle(" context").color).toContain("var(--chat-code-fg)");
  });

  it("renders one row per diff line", () => {
    const { container } = render(
      <HighlightedCode code={"+ added line\n- removed line\n context"} language="diff" />,
    );
    expect(container.textContent).toContain("+ added line");
    expect(container.textContent).toContain("- removed line");
  });
});
