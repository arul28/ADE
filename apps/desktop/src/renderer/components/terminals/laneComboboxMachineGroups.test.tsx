/* @vitest-environment jsdom */

/*
 * Covers the machine grouping added to `terminals/LaneCombobox`. It lives with
 * the rest of the lane-machine work so the feature's tests stay together.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_CREATE_LANE_OPTION_ID,
  LaneCombobox,
  autoCreateLaneOptionId,
  isAutoCreateLaneOptionId,
  machineIdFromAutoCreateLaneOptionId,
} from "./LaneCombobox";

afterEach(cleanup);

const autoCreateLane = {
  id: AUTO_CREATE_LANE_OPTION_ID,
  name: "Auto-create lane",
  color: null,
  branchRef: null,
};

const lanes = [
  autoCreateLane,
  { id: "lane-local", name: "auth-refresh", color: "#7C5CFF", branchRef: "refs/heads/auth-refresh" },
  { id: "lane-studio", name: "render-perf", color: null, branchRef: "refs/heads/render-perf", machineId: "studio" },
];

const machines = [
  { id: "this-mac", name: "This Mac" },
  { id: "studio", name: "MacBook Pro (97)" },
];

function openList(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
  return screen.getByPlaceholderText("Search lanes...").closest(".ade-lane-popover") as HTMLElement;
}

describe("auto-create lane option ids", () => {
  it("keeps the bare id for the default machine", () => {
    expect(autoCreateLaneOptionId()).toBe(AUTO_CREATE_LANE_OPTION_ID);
    expect(autoCreateLaneOptionId(null)).toBe(AUTO_CREATE_LANE_OPTION_ID);
    expect(machineIdFromAutoCreateLaneOptionId(AUTO_CREATE_LANE_OPTION_ID)).toBeNull();
  });

  it("namespaces other machines and stays recognizable", () => {
    const id = autoCreateLaneOptionId("studio");
    expect(id).not.toBe(AUTO_CREATE_LANE_OPTION_ID);
    expect(isAutoCreateLaneOptionId(id)).toBe(true);
    expect(machineIdFromAutoCreateLaneOptionId(id)).toBe("studio");
    expect(isAutoCreateLaneOptionId("lane-1")).toBe(false);
  });
});

describe("LaneCombobox machine grouping", () => {
  it("renders one flat list when there is nothing to group by", () => {
    render(<LaneCombobox lanes={lanes} value="lane-local" onChange={vi.fn()} />);
    const popover = openList();

    expect(within(popover).queryByText("This Mac")).toBeNull();
    expect(within(popover).getAllByText("Auto-create lane")).toHaveLength(1);
    expect(within(popover).queryByText("Auto-create lane here")).toBeNull();
  });

  it("groups lanes under machine headers with an auto-create row each", () => {
    render(<LaneCombobox lanes={lanes} machines={machines} value="lane-local" onChange={vi.fn()} />);
    const popover = openList();

    expect(within(popover).getByText("This Mac")).toBeTruthy();
    expect(within(popover).getByText("MacBook Pro (97)")).toBeTruthy();
    expect(within(popover).getAllByText("Auto-create lane here")).toHaveLength(2);

    const rows = Array.from(popover.querySelectorAll(".ade-lane-popover-list > *")).map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(rows[0]).toBe("This Mac");
    expect(rows[1]).toContain("auth-refresh");
    expect(rows[2]).toBe("Auto-create lane here");
    expect(rows[3]).toBe("MacBook Pro (97)");
    expect(rows[4]).toContain("render-perf");
    expect(rows[5]).toBe("Auto-create lane here");
  });

  it("selects the per-machine auto-create row with its own id", () => {
    const onChange = vi.fn();
    render(<LaneCombobox lanes={lanes} machines={machines} value="lane-local" onChange={onChange} />);
    const popover = openList();

    const autoCreateRows = within(popover).getAllByText("Auto-create lane here");
    fireEvent.click(autoCreateRows[0]!);
    expect(onChange).toHaveBeenCalledWith(AUTO_CREATE_LANE_OPTION_ID);

    onChange.mockClear();
    fireEvent.click(openList().querySelectorAll(".ade-lane-popover-item-featured")[1]!);
    expect(onChange).toHaveBeenCalledWith(autoCreateLaneOptionId("studio"));
  });

  it("drops machine headers whose lanes are filtered out by search", () => {
    render(<LaneCombobox lanes={lanes} machines={machines} value="lane-local" onChange={vi.fn()} />);
    const popover = openList();

    fireEvent.change(within(popover).getByPlaceholderText("Search lanes..."), {
      target: { value: "render" },
    });

    expect(within(popover).queryByText("This Mac")).toBeNull();
    expect(within(popover).getByText("MacBook Pro (97)")).toBeTruthy();
    expect(within(popover).getAllByText("render-perf").length).toBeGreaterThan(0);
  });

  it("keeps arrow-key navigation on selectable rows only", () => {
    const onChange = vi.fn();
    render(<LaneCombobox lanes={lanes} machines={machines} value="lane-local" onChange={onChange} />);
    const popover = openList();

    const search = within(popover).getByPlaceholderText("Search lanes...");
    // Highlight starts on the selected lane (index 0 of the selectable rows).
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(AUTO_CREATE_LANE_OPTION_ID);
  });

  it("labels a selected per-machine auto-create row on the trigger", () => {
    render(
      <LaneCombobox
        lanes={lanes}
        machines={machines}
        value={autoCreateLaneOptionId("studio")}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Select lane" }).textContent).toContain(
      "Auto-create lane",
    );
  });
});
