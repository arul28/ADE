/* @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanMarkdown, slugify } from "./PlanMarkdown";

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
    // "Open in ADE browser" button rendered.
    const btn = card?.querySelector("button");
    expect(btn?.textContent ?? "").toMatch(/Open in ADE browser/i);
  });

  it("renders ordinary anchors with openUrlInAdeBrowser fallback (no spec card)", () => {
    const { container } = render(
      <PlanMarkdown source={"see [docs](https://example.com)"} />,
    );
    expect(container.querySelector("[data-plan-spec-card]")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
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
