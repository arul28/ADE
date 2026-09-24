/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const codeToHtml = vi.fn((code: string) => `<pre class="shiki" style="background-color:#22272e"><code><span class="line">${code}</span></code></pre>`);

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(async () => ({ codeToHtml })),
  createJavaScriptRegexEngine: vi.fn(() => ({})),
}));

import { HighlightedCode } from "./CodeHighlighter";

describe("HighlightedCode", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a cached block highlighted on the first frame, with no plain-text pass", async () => {
    const first = render(<HighlightedCode code="const cached = 1;" language="typescript" />);
    // Uncached: plain first, then the highlight lands.
    expect(first.container.querySelector(".shiki-highlighted")).toBeNull();
    await waitFor(() => expect(first.container.querySelector(".shiki-highlighted pre.shiki")).not.toBeNull());
    first.unmount();
    const calls = codeToHtml.mock.calls.length;

    // A remount (a virtualized row scrolling back in, a reopened chat): the
    // very first render is already highlighted, synchronously.
    const second = render(<HighlightedCode code="const cached = 1;" language="typescript" />);
    expect(second.container.querySelector(".shiki-highlighted pre.shiki")?.textContent).toBe("const cached = 1;");
    expect(second.container.querySelector("pre:not(.shiki)")).toBeNull();
    expect(codeToHtml.mock.calls.length).toBe(calls);
  });

  it("lays the plain and highlighted blocks out the same way, so the swap keeps the row's height", async () => {
    const view = render(<HighlightedCode code="const wraps = 'the same way';" language="typescript" />);
    const plain = view.container.querySelector("pre");
    expect(plain?.className).toContain("whitespace-pre-wrap");
    expect(plain?.className).toContain("text-[11px]");
    expect(plain?.className).toContain("leading-[1.6]");

    await waitFor(() => expect(view.container.querySelector(".shiki-highlighted")).not.toBeNull());
    const wrapper = view.container.querySelector(".shiki-highlighted")!;
    // Shiki's own <pre> is given the same wrapping, size, and line height.
    for (const token of ["[&_pre]:whitespace-pre-wrap", "[&_pre]:text-[11px]", "[&_pre]:leading-[1.6]", "[&_pre]:!m-0"]) {
      expect(wrapper.className).toContain(token);
    }
  });

  it("shows new text plain until it highlights, never the previous block's highlight", async () => {
    const view = render(<HighlightedCode code="let a = 1;" language="typescript" />);
    await waitFor(() => expect(view.container.querySelector(".shiki-highlighted")).not.toBeNull());
    view.rerender(<HighlightedCode code={"let a = 1;\nlet b = 2;"} language="typescript" />);
    expect(view.container.querySelector("pre")?.textContent).toBe("let a = 1;\nlet b = 2;");
    await waitFor(() => expect(view.container.querySelector(".shiki-highlighted pre.shiki")?.textContent)
      .toBe("let a = 1;\nlet b = 2;"));
  });
});
