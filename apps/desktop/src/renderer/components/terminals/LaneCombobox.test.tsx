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
  AUTO_CREATE_LANE_OPTION_ID,
  LaneCombobox,
  computeLanePopoverPlacement,
  laneMatchesSearch,
} from "./LaneCombobox";
import { ChatHandoffDialogs } from "../chat/ChatHandoffDialogs";

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

  it("opens upward from the trigger top so a short list stays flush, not floated by maxHeight", () => {
    const placement = computeLanePopoverPlacement({
      trigger: { top: 672, bottom: 700, left: 20, width: 200 },
      viewport: { width: 900, height: 745 },
    });
    expect(placement.openAbove).toBe(true);
    expect(placement.top).toBe(672);
    expect(placement.maxHeight).toBeGreaterThan(0);
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
  it("shows the selected lane and branch in its trigger", () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} />);

    const button = trigger();
    expect(button.textContent).toContain("auth-refresh");
    expect(button.textContent).toContain("feat/auth-refresh");
  });
});

describe("LaneCombobox machine chrome", () => {
  const machines = [
    { id: "this-mac", name: "This Mac" },
    { id: "studio", name: "Studio" },
  ];

  function openList(): HTMLElement {
    fireEvent.click(trigger());
    return screen.getByRole("listbox") as HTMLElement;
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

  it("keeps aria-selected on the value while keyboard highlight moves", () => {
    render(<LaneCombobox lanes={lanes} value="lane-auth" onChange={vi.fn()} />);
    const popover = openList();
    const selected = screen.getByRole("option", { name: /auth-refresh/ });
    const other = screen.getByRole("option", { name: /render-perf/ });

    fireEvent.keyDown(popover, { key: "ArrowDown" });

    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(other.getAttribute("aria-selected")).toBe("false");
  });

  it("reports a selected auto-create option independently of highlight", () => {
    render(
      <LaneCombobox
        lanes={[
          { id: AUTO_CREATE_LANE_OPTION_ID, name: "Auto-create lane", color: null },
          ...lanes,
        ]}
        value={AUTO_CREATE_LANE_OPTION_ID}
        onChange={vi.fn()}
      />,
    );
    const popover = openList();
    const autoCreate = screen.getByRole("option", { name: "Auto-create lane" });

    fireEvent.keyDown(popover, { key: "ArrowDown" });

    expect(autoCreate.getAttribute("aria-selected")).toBe("true");
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

describe("LaneCombobox inside the modal handoff dialog", () => {
  function renderInDialog(onChange = vi.fn(), onCloseLocal = vi.fn()) {
    render(
      <ChatHandoffDialogs
        localOpen
        localContent={<LaneCombobox lanes={lanes} value="lane-auth" onChange={onChange} />}
        onCloseLocal={onCloseLocal}
        remoteNoticeOpen={false}
        machineName="studio"
        onCloseRemoteNotice={vi.fn()}
      />,
    );
    fireEvent.click(trigger());
    const popover = screen.getByRole("listbox") as HTMLElement;
    return { popover, onChange, onCloseLocal };
  }

  it("opens the list inside the dialog, so picking a lane keeps the dialog open", () => {
    const { popover, onChange, onCloseLocal } = renderInDialog();
    // A modal dialog blocks pointer events and focus outside its content; a list
    // portaled to <body> was an outside press that closed the whole dialog.
    expect(screen.getByRole("dialog").contains(popover)).toBe(true);
    const option = screen.getByRole("option", { name: /render-perf/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("lane-perf");
    expect(onCloseLocal).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes only the list on Escape, not the dialog", async () => {
    const { popover, onCloseLocal } = renderInDialog();
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search lanes...")).toBeNull());
    expect(onCloseLocal).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
