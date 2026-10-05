/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const { codeToHtml } = vi.hoisted(() => ({ codeToHtml: vi.fn() }));

// The real highlighter, with its whole-block render counted.
vi.mock("shiki", async (importOriginal) => {
  const shiki = await importOriginal<typeof import("shiki")>();
  return {
    ...shiki,
    createHighlighter: async (options: Parameters<typeof shiki.createHighlighter>[0]) => {
      const highlighter = await shiki.createHighlighter(options);
      const render = highlighter.codeToHtml.bind(highlighter);
      codeToHtml.mockImplementation(render);
      highlighter.codeToHtml = codeToHtml as unknown as typeof highlighter.codeToHtml;
      return highlighter;
    },
  };
});

import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
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

  it("highlights a streaming block the same as a whole-block render at every frame", async () => {
    const reference = await createHighlighter({
      themes: ["github-dark-dimmed"],
      langs: ["typescript"],
      engine: createJavaScriptRegexEngine(),
    });
    // A template literal and a block comment span lines, so a frame is only
    // right when the grammar state carries across the lines already rendered.
    const lines = [
      "const greeting = `hello",
      "  ${name} and",
      "  more`;",
      "/* opens a comment",
      "   still a comment */",
      "function add(a: number, b: number) {",
      "  return a + b;",
      "}",
    ];
    const frames: string[] = [];
    for (let i = 1; i <= lines.length; i++) {
      const text = lines.slice(0, i).join("\n");
      frames.push(text.slice(0, -3), text, `${text}\n\n`);
    }

    const view = render(<HighlightedCode code={frames[0]!} language="typescript" />);
    const expected = document.createElement("div");
    for (const frame of frames) {
      view.rerender(<HighlightedCode code={frame} language="typescript" />);
      // The block drops one trailing newline before it highlights.
      const shown = frame.replace(/\n$/, "");
      expected.innerHTML = reference.codeToHtml(shown, { lang: "typescript", theme: "github-dark-dimmed" });
      await waitFor(() => expect(view.container.querySelector(".shiki-highlighted pre.shiki")?.textContent).toBe(shown));
      expect(view.container.querySelector(".shiki-highlighted")?.innerHTML, `frame ${JSON.stringify(frame)}`)
        .toBe(expected.innerHTML);
    }
    expect(view.container.querySelectorAll(".shiki-highlighted .line").length).toBe(lines.length + 1);
  });
});
