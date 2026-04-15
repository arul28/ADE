// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrMarkdown } from "./PrMarkdown";

// Keep Shiki out of the unit test — we only care that fenced code blocks
// route *through* the shared highlighter component (i.e. a `language-diff`
// or `language-ts` fence produces the highlighter wrapper), not that Shiki
// actually paints tokens.
vi.mock("../../chat/CodeHighlighter.tsx", () => ({
  HighlightedCode: ({ code, language }: { code: string; language: string }) => (
    <div data-testid="highlighted-code" data-language={language}>
      {code}
    </div>
  ),
}));

const BASE_PROPS = { repoOwner: "acme", repoName: "ade" } as const;

const openExternal = vi.fn(async (_url: string) => {});

beforeEach(() => {
  openExternal.mockClear();
  (window as unknown as { ade?: unknown }).ade = {
    app: { openExternal },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("PrMarkdown", () => {
  it("renders <details>/<summary> as a toggleable accordion", () => {
    const markdown = [
      "<details>",
      "<summary>Greptile analysis</summary>",
      "",
      "Hidden review body content goes here.",
      "",
      "</details>",
    ].join("\n");

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const toggle = screen.getByRole("button", { name: /greptile analysis/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The hidden-by-default body should still be in the DOM (collapsed, not removed).
    expect(screen.getByText(/hidden review body content/i)).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders GFM tables with a sticky header wrapper", () => {
    const markdown = [
      "| col a | col b |",
      "| --- | --- |",
      "| one | two |",
      "| three | four |",
    ].join("\n");

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /col a/i })).toBeTruthy();
    // Sticky thead gets a marker class we assert on so downstream styling stays stable.
    const thead = table.querySelector("thead");
    expect(thead).toBeTruthy();
    expect(thead?.className).toContain("pr-md-thead");
  });

  it("routes fenced diff blocks through the shared CodeHighlighter", () => {
    const markdown = [
      "```diff",
      "- removed line",
      "+ added line",
      "```",
    ].join("\n");

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const highlighted = screen.getByTestId("highlighted-code");
    expect(highlighted.getAttribute("data-language")).toBe("diff");
    expect(highlighted.textContent).toContain("- removed line");
    expect(highlighted.textContent).toContain("+ added line");
  });

  it("autolinks #123 to the repo PR and @user to the GitHub profile", () => {
    const markdown = "See #123 — thanks @octocat for the review!";

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const prLink = screen.getByRole("link", { name: "#123" }) as HTMLAnchorElement;
    expect(prLink.getAttribute("href")).toBe("https://github.com/acme/ade/pull/123");
    expect(prLink.getAttribute("data-pr-link-kind")).toBe("pr");

    const mention = screen.getByRole("link", { name: "@octocat" }) as HTMLAnchorElement;
    expect(mention.getAttribute("href")).toBe("https://github.com/octocat");
    expect(mention.getAttribute("data-pr-link-kind")).toBe("mention");
  });

  it("does not autolink #123 or @user inside code spans", () => {
    const markdown = "Look at `#999` and `@ghost` — literal strings.";

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    expect(screen.queryByRole("link", { name: "#999" })).toBeNull();
    expect(screen.queryByRole("link", { name: "@ghost" })).toBeNull();
  });

  it("opens images via window.ade.app.openExternal when clicked", () => {
    const markdown = "![alt text](https://example.test/pic.png)";

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const img = screen.getByRole("img", { name: /alt text/i }) as HTMLImageElement;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe("https://example.test/pic.png");

    fireEvent.click(img);
    expect(openExternal).toHaveBeenCalledWith("https://example.test/pic.png");
  });

  it("opens external links via the Electron bridge and prevents default navigation", () => {
    const markdown = "[ADE docs](https://example.test/docs)";

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const link = screen.getByRole("link", { name: /ade docs/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.test/docs");

    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("strips <script> tags from raw HTML", () => {
    const markdown = [
      "Safe preamble.",
      "",
      '<script>window.__pwn = 1;</script>',
      "",
      "Safe trailing.",
    ].join("\n");

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const container = screen.getByText(/safe preamble/i).closest(".pr-md-root");
    expect(container).toBeTruthy();
    expect(container?.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });

  it("renders task-list checkboxes as read-only", () => {
    const markdown = ["- [x] Done item", "- [ ] Open item"].join("\n");

    render(<PrMarkdown {...BASE_PROPS}>{markdown}</PrMarkdown>);

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[0].disabled).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
    expect(checkboxes[1].disabled).toBe(true);
  });
});
