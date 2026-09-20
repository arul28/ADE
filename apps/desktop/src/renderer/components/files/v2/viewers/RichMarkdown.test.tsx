/* @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichMarkdown, slugify } from "./RichMarkdown";

// Mermaid lazy-imports inside the component; stub it so the spawned import
// resolves immediately to a no-op renderer.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg data-testid=\"mermaid-svg\"></svg>" })),
  },
}));

// Spread the real module so newer exports (`openLinkFromUi`, …) stay defined for
// anything else in the tree that imports them; only the opener is stubbed.
vi.mock("../../../../lib/openExternal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/openExternal")>()),
  openUrlInAdeBrowser: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

describe("slugify (rehype-slug equivalent)", () => {
  it("lowercases + dashes + strips punctuation", () => {
    const taken = new Set<string>();
    expect(slugify("Hello, world!", taken)).toBe("hello-world");
    // Em-dash strips → consecutive dashes collapse to one.
    expect(slugify("Plan — Phase 1", taken)).toBe("plan-phase-1");
  });

  it("dedupes repeat slugs with -2, -3 suffixes", () => {
    const taken = new Set<string>();
    expect(slugify("Goal", taken)).toBe("goal");
    expect(slugify("Goal", taken)).toBe("goal-2");
    expect(slugify("Goal", taken)).toBe("goal-3");
  });

  it("falls back to 'section' for empty input", () => {
    const taken = new Set<string>();
    expect(slugify("", taken)).toBe("section");
  });
});

describe("RichMarkdown", () => {
  it("renders headings with stable data-section-id anchors", () => {
    const { container } = render(
      <RichMarkdown source={"# Run goal\n\nbody\n\n## Phase A\n\nmore"} />,
    );
    const headings = Array.from(container.querySelectorAll("[data-section-id]"));
    expect(headings.length).toBeGreaterThanOrEqual(2);
    const ids = headings.map((h) => h.getAttribute("data-section-id"));
    expect(ids).toContain("run-goal");
    expect(ids).toContain("phase-a");
    // The same content should produce the same ids on a re-render (stability).
    const { container: container2 } = render(
      <RichMarkdown source={"# Run goal\n\nbody\n\n## Phase A\n\nmore"} />,
    );
    const ids2 = Array.from(container2.querySelectorAll("[data-section-id]")).map((h) =>
      h.getAttribute("data-section-id"),
    );
    expect(ids2).toEqual(ids);
  });

  it("renders anchors with the in-app opener", () => {
    const { container } = render(
      <RichMarkdown source={"see [docs](https://example.com)"} />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
  });

  it("renders inline images at their stated source", () => {
    const { container } = render(
      <RichMarkdown source={"![chart](artifacts/evidence/chart.png)"} />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("artifacts/evidence/chart.png");
  });

  it("sanitizes raw html while preserving document-safe anchors and subscript", () => {
    const { container } = render(
      <RichMarkdown
        source={[
          "<script>alert(1)</script>",
          "<a href=\"javascript:alert(1)\">bad href</a>",
          "<sub>2026-05-22</sub>",
          "<a id=\"section-foo\" href=\"#phase-a\">jump</a>",
        ].join("\n\n")}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent ?? "").not.toContain("alert(1)");

    const links = Array.from(container.querySelectorAll("a"));
    const badHref = links.find((link) => link.textContent === "bad href");
    expect(badHref).toBeTruthy();
    expect(badHref?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);

    expect(container.querySelector("sub")?.textContent).toBe("2026-05-22");
    const anchor = container.querySelector("a#section-foo");
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute("href")).toBe("#phase-a");
  });

  it("renders mermaid blocks via a lazy loader placeholder", async () => {
    const source = "```mermaid\ngraph TD; A-->B;\n```";
    const { container } = render(<RichMarkdown source={source} />);
    // Either the loading placeholder OR the resolved svg should be present.
    const block = container.querySelector("[data-mermaid-block], [role='status']");
    expect(block).toBeTruthy();
  });

  it("renders gfm tables", () => {
    const source = "| col | val |\n| --- | --- |\n| a   | 1   |";
    const { container } = render(<RichMarkdown source={source} />);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("th")?.textContent ?? "").toMatch(/col/);
  });
});
