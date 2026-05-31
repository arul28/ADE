/* @vitest-environment jsdom */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanMarkdown, slugify } from "./PlanMarkdown";
import { openUrlInAdeBrowser } from "../../lib/openExternal";

// Mermaid lazy-imports inside the component; stub it so the spawned import
// resolves immediately to a no-op renderer.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg data-testid=\"mermaid-svg\"></svg>" })),
  },
}));

vi.mock("../../lib/openExternal", () => ({
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

describe("PlanMarkdown", () => {
  it("renders headings with stable data-section-id anchors", () => {
    const { container } = render(
      <PlanMarkdown source={"# Run goal\n\nbody\n\n## Phase A\n\nmore"} />,
    );
    const headings = Array.from(container.querySelectorAll("[data-section-id]"));
    expect(headings.length).toBeGreaterThanOrEqual(2);
    const ids = headings.map((h) => h.getAttribute("data-section-id"));
    expect(ids).toContain("run-goal");
    expect(ids).toContain("phase-a");
    // The same content should produce the same ids on a re-render (stability).
    const { container: container2 } = render(
      <PlanMarkdown source={"# Run goal\n\nbody\n\n## Phase A\n\nmore"} />,
    );
    const ids2 = Array.from(container2.querySelectorAll("[data-section-id]")).map((h) =>
      h.getAttribute("data-section-id"),
    );
    expect(ids2).toEqual(ids);
  });

  it("renders an anchor referencing artifacts/ui/*.html as a spec preview card", () => {
    const { container } = render(
      <PlanMarkdown
        source={"see [the login spec](artifacts/ui/login.html)"}
        resolveAsset={(p) => ({ url: `file:///run/${p}`, kind: "html" })}
      />,
    );
    const card = container.querySelector("[data-plan-spec-card]");
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-plan-spec-card")).toBe("artifacts/ui/login.html");
    // iframe should have a strict empty sandbox.
    const iframe = card?.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe("");
    expect(iframe?.getAttribute("src")).toBe("file:///run/artifacts/ui/login.html");
    // "View full design" button rendered and opens the resolved file URL.
    const btn = card?.querySelector("button");
    expect(btn?.textContent ?? "").toMatch(/View full design/i);
    if (!btn) throw new Error("missing full design button");
    fireEvent.click(btn);
    expect(openUrlInAdeBrowser).toHaveBeenCalledWith("file:///run/artifacts/ui/login.html");
  });

  it("renders ordinary anchors with openUrlInAdeBrowser fallback (no spec card)", () => {
    const { container } = render(
      <PlanMarkdown source={"see [docs](https://example.com)"} />,
    );
    expect(container.querySelector("[data-plan-spec-card]")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
  });

  it("resolves inline image assets from the bundle root when no resolver is provided", () => {
    const { container } = render(
      <PlanMarkdown
        source={"![chart](artifacts/evidence/chart.png)"}
        bundleRoot="/tmp/ade-bundle"
      />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("file:///tmp/ade-bundle/artifacts/evidence/chart.png");
  });

  it("sanitizes raw html while preserving plan-safe anchors and subscript", () => {
    const { container } = render(
      <PlanMarkdown
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
    const { container } = render(<PlanMarkdown source={source} />);
    // Either the loading placeholder OR the resolved svg should be present.
    const block = container.querySelector("[data-mermaid-block], [role='status']");
    expect(block).toBeTruthy();
  });

  it("renders gfm tables", () => {
    const source = "| col | val |\n| --- | --- |\n| a   | 1   |";
    const { container } = render(<PlanMarkdown source={source} />);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("th")?.textContent ?? "").toMatch(/col/);
  });
});
