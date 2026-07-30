/* @vitest-environment jsdom */

/*
 * Covers the sleek single-line `LaneCombobox` trigger, its search predicate, and
 * the two measured invariants the Work perf pass recorded for this component:
 * a `fullWidth` trigger must fill a narrow parent without overflowing it, and
 * the popover must clamp to the renderer viewport on both axes.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LaneCombobox,
  computeLanePopoverPlacement,
  laneMatchesSearch,
} from "./LaneCombobox";

afterEach(cleanup);

const lanes = [
  { id: "lane-auth", name: "auth-refresh", color: "#7C5CFF", branchRef: "refs/heads/feat/auth-refresh" },
  { id: "lane-perf", name: "render-perf", color: null, branchRef: "refs/heads/perf/render" },
];

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: "Select lane" });
}

describe("laneMatchesSearch", () => {
  const lane = { name: "auth-refresh", branchLabel: "feat/auth-token" };

  it("keeps every row for an empty or whitespace query", () => {
    expect(laneMatchesSearch(lane, "")).toBe(true);
    expect(laneMatchesSearch(lane, "   ")).toBe(true);
  });

  it("matches on lane name and on branch, case-insensitively", () => {
    expect(laneMatchesSearch(lane, "REFRESH")).toBe(true);
    expect(laneMatchesSearch(lane, " token ")).toBe(true);
    expect(laneMatchesSearch({ name: "primary", branchLabel: null }, "main")).toBe(false);
  });

  it("still matches when the caller passes a full ref instead of a short label", () => {
    expect(laneMatchesSearch({ name: "x", branchLabel: "refs/heads/feat/auth" }, "feat/auth")).toBe(true);
  });
});

describe("computeLanePopoverPlacement", () => {
  it("clamps a right-edge trigger back inside the viewport", () => {
    const placement = computeLanePopoverPlacement({
      trigger: { top: 40, bottom: 68, left: 534, width: 40 },
      viewport: { width: 582, height: 745 },
    });
    expect(placement.left + placement.width).toBeLessThanOrEqual(582 - 10);
    expect(placement.left).toBeGreaterThanOrEqual(10);
  });

  it("opens upward and stays off the top edge when the trigger sits low", () => {
    const placement = computeLanePopoverPlacement({
      trigger: { top: 672, bottom: 700, left: 20, width: 200 },
      viewport: { width: 900, height: 745 },
    });
    expect(placement.openAbove).toBe(true);
    expect(placement.bottom).toBeDefined();
    const top = 745 - (placement.bottom ?? 0) - placement.maxHeight;
    expect(top).toBeGreaterThanOrEqual(10);
  });

  it("detaches from the anchor rather than overflowing when neither side fits", () => {
    const placement = computeLanePopoverPlacement({
      trigger: { top: 90, bottom: 110, left: 20, width: 200 },
      viewport: { width: 400, height: 200 },
    });
    expect(placement.top).toBeDefined();
    expect(placement.top ?? 0).toBeGreaterThanOrEqual(10);
    expect((placement.top ?? 0) + placement.maxHeight).toBeLessThanOrEqual(200 - 10);
  });
});

describe("LaneCombobox trigger", () => {
  it("renders lane and branch on one line with the branch giving way first", () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} />);

    const button = trigger();
    expect(button.textContent).toContain("auth-refresh");
    expect(button.textContent).toContain("feat/auth-refresh");
    // Single line: fixed height, no auto-growing column.
    expect(button.className).toContain("h-[30px]");
    expect(button.className).not.toContain("flex-col");

    const branch = button.querySelector(".shrink-\\[9999\\]");
    expect(branch?.textContent).toContain("feat/auth-refresh");
  });

  it("uses the compact height when asked", () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} compact />);
    expect(trigger().className).toContain("h-7");
  });

  it("fills a narrow parent without a width cap or intrinsic floor", () => {
    render(
      <div style={{ width: 120 }}>
        <LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} fullWidth />
      </div>,
    );

    const button = trigger();
    expect(button.className).toContain("w-full");
    expect(button.className).toContain("min-w-0");
    // A max-width below the parent is exactly what overflowed the 120px filter
    // panel in the measured Work run; `fullWidth` must not reintroduce one.
    expect(button.className).not.toMatch(/\bmax-w-/);
    expect(button.style.width).toBe("");
    expect(button.style.minWidth).toBe("");
    // Every text run inside can collapse, so nothing establishes a min-content floor.
    for (const span of Array.from(button.querySelectorAll("span"))) {
      if (span.className.includes("truncate") && !span.className.includes("min-w-0")) {
        expect(span.parentElement?.className).toContain("min-w-0");
      }
    }
  });

  it("caps its own width when it is not asked to fill the parent", () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} variant="pill" />);
    expect(trigger().className).toContain("max-w-[320px]");
  });
});

describe("LaneCombobox machine chrome", () => {
  const machines = [
    { id: "this-mac", name: "This Mac" },
    { id: "studio", name: "Studio" },
  ];

  function openList(): HTMLElement {
    fireEvent.click(trigger());
    return screen.getByPlaceholderText("Search lanes...").closest(".ade-lane-popover") as HTMLElement;
  }

  it("renders no machine chrome at all for a single machine", () => {
    render(
      <LaneCombobox
        lanes={lanes}
        machines={[machines[0]!]}
        value="lane-auth"
        onChange={vi.fn()}
      />,
    );
    expect(openList().querySelectorAll("[data-machine-header]")).toHaveLength(0);
  });

  it("opens without auto-focusing the search field", async () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} />);
    const popover = openList();

    await waitFor(() => {
      expect(document.activeElement).toBe(popover);
    });
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText("Search lanes..."));
  });

  it("promotes machines to section headers once there is more than one", () => {
    render(
      <LaneCombobox
        lanes={[
          { ...lanes[0]!, machineId: "this-mac" },
          { ...lanes[1]!, machineId: "studio" },
        ]}
        machines={machines}
        value="lane-auth"
        onChange={vi.fn()}
      />,
    );
    const headers = Array.from(openList().querySelectorAll("[data-machine-header]"));
    expect(headers.map((node) => node.textContent)).toEqual(["This Mac", "Studio"]);
  });

  it("filters rows by branch as well as name", () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} />);
    const popover = openList();

    fireEvent.change(screen.getByPlaceholderText("Search lanes..."), {
      target: { value: "perf/render" },
    });

    const rows = Array.from(popover.querySelectorAll(".ade-lane-popover-item"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("render-perf");
  });
});
