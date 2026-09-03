import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  AUTO_CREATE_LANE_OPTION_ID,
  LaneCombobox,
  autoCreateLaneOptionId,
  branchNameFromLaneRef,
  computeLanePopoverPlacement,
  isAutoCreateLaneOptionId,
  laneDisplayColor,
  laneMatchesSearch,
  machineIdFromAutoCreateLaneOptionId,
  machineLaneFromOptionId,
  machineLaneOptionId,
} from "../src/lanes";

afterEach(cleanup);

describe("computeLanePopoverPlacement", () => {
  const viewport = { width: 1200, height: 900 };

  it("opens below when the space under the trigger is enough", () => {
    const placement = computeLanePopoverPlacement({
      trigger: { top: 100, bottom: 130, left: 40, width: 260 },
      viewport,
    });
    expect(placement.openAbove).toBe(false);
    expect(placement.top).toBe(134); // bottom + POPOVER_GAP
    expect(placement.transform).toBeUndefined();
    expect(placement.maxHeight).toBe(320);
  });

  it("opens above when there is more room above than below", () => {
    const placement = computeLanePopoverPlacement({
      trigger: { top: 800, bottom: 830, left: 40, width: 260 },
      viewport,
    });
    expect(placement.openAbove).toBe(true);
    // Anchored to the trigger's own top edge, then shifted by its own height.
    expect(placement.top).toBe(800);
    expect(placement.transform).toContain("-100%");
  });

  it("clamps both axes and detaches when neither side fits", () => {
    // A short viewport with the trigger dead centre: 100px above, 100px below.
    const placement = computeLanePopoverPlacement({
      trigger: { top: 110, bottom: 140, left: 1180, width: 400 },
      viewport: { width: 300, height: 240 },
    });
    // Width capped to the viewport minus both pads, left clamped inside it.
    expect(placement.width).toBe(280);
    expect(placement.left).toBe(10);
    expect(placement.left + placement.width).toBeLessThanOrEqual(300 - 10);
    // Height fell back to the minimum, and the box no longer hangs off the end.
    expect(placement.openAbove).toBe(false);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(240 - 10);
  });
});

describe("lane option ids", () => {
  it("round-trips a machine + lane pair, including a lane id with a colon", () => {
    const id = machineLaneOptionId("mac-97", "lane:with:colons");
    expect(machineLaneFromOptionId(id)).toEqual({
      machineId: "mac-97",
      laneId: "lane:with:colons",
    });
  });

  it("returns null for ids that are not machine-routed", () => {
    expect(machineLaneFromOptionId("plain-lane")).toBeNull();
    expect(machineLaneFromOptionId(null)).toBeNull();
  });

  it("recognises the bare and the per-machine auto-create forms", () => {
    expect(isAutoCreateLaneOptionId(AUTO_CREATE_LANE_OPTION_ID)).toBe(true);
    expect(isAutoCreateLaneOptionId(autoCreateLaneOptionId("mac-97"))).toBe(true);
    expect(isAutoCreateLaneOptionId("lane-1")).toBe(false);
    expect(machineIdFromAutoCreateLaneOptionId(autoCreateLaneOptionId("mac-97"))).toBe("mac-97");
    expect(machineIdFromAutoCreateLaneOptionId(AUTO_CREATE_LANE_OPTION_ID)).toBeNull();
  });
});

describe("laneMatchesSearch", () => {
  it("matches on the lane name and on the branch label", () => {
    const lane = { name: "Payments", branchLabel: "ade/checkout-fix" };
    expect(laneMatchesSearch(lane, "")).toBe(true);
    expect(laneMatchesSearch(lane, "pay")).toBe(true);
    expect(laneMatchesSearch(lane, "CHECKOUT")).toBe(true);
    expect(laneMatchesSearch(lane, "invoices")).toBe(false);
    expect(laneMatchesSearch({ name: "Payments" }, "checkout")).toBe(false);
  });
});

describe("lane identity helpers", () => {
  it("reduces refs to a short branch and falls back to white", () => {
    expect(branchNameFromLaneRef("refs/heads/ade/foo")).toBe("ade/foo");
    expect(branchNameFromLaneRef("refs/remotes/origin/ade/foo")).toBe("ade/foo");
    expect(branchNameFromLaneRef("origin/main")).toBe("main");
    expect(laneDisplayColor("  ")).toBe("#ffffff");
    expect(laneDisplayColor("#ff0000")).toBe("#ff0000");
  });
});

const LANES = [
  { id: "lane-1", name: "Payments", color: "#ff0000", branchRef: "refs/heads/ade/payments" },
  { id: "lane-2", name: "Search", branchRef: "refs/heads/ade/search" },
];

function Harness(props: {
  lanes?: typeof LANES;
  machines?: { id: string; name: string }[];
  onChange: (id: string) => void;
}) {
  const [value, setValue] = useState("lane-1");
  return (
    <LaneCombobox
      lanes={props.lanes ?? LANES}
      {...(props.machines ? { machines: props.machines } : {})}
      value={value}
      onChange={(id) => {
        setValue(id);
        props.onChange(id);
      }}
    />
  );
}

describe("LaneCombobox", () => {
  it("opens on click and lists every lane", async () => {
    render(<Harness onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    const listbox = await screen.findByRole("listbox");
    expect(listbox.className).toContain("ade-lane-popover");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("filters rows as the user types", async () => {
    render(<Harness onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    await screen.findByRole("listbox");
    fireEvent.change(screen.getByLabelText("Search lanes"), { target: { value: "sea" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option").textContent).toContain("Search");
    // Branch text filters too.
    fireEvent.change(screen.getByLabelText("Search lanes"), { target: { value: "ade/payments" } });
    await waitFor(() => expect(screen.getByRole("option").textContent).toContain("Payments"));
    fireEvent.change(screen.getByLabelText("Search lanes"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No lanes found")).toBeTruthy());
  });

  it("selects the highlighted row with ArrowDown + Enter", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    const listbox = await screen.findByRole("listbox");
    // Opens highlighting the selected row (lane-1, index 0); step to lane-2.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("lane-2"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape without selecting", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    const listbox = await screen.findByRole("listbox");
    fireEvent.keyDown(listbox, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws no machine header for a single machine", async () => {
    render(<Harness machines={[{ id: "m1", name: "This computer" }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    await screen.findByRole("listbox");
    expect(document.querySelectorAll("[data-machine-header='true']")).toHaveLength(0);
  });

  it("groups by machine, and drops a header whose group filters empty", async () => {
    const lanes = [
      { id: "lane-1", name: "Payments", color: "#ff0000", branchRef: "refs/heads/ade/payments" },
      { id: "lane-2", name: "Search", branchRef: "refs/heads/ade/search", machineId: "m2" },
    ];
    render(
      <Harness
        lanes={lanes}
        machines={[{ id: "m1", name: "This computer" }, { id: "m2", name: "MacBook Pro" }]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    await screen.findByRole("listbox");
    expect(document.querySelectorAll("[data-machine-header='true']")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Search lanes"), { target: { value: "payments" } });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-machine-header='true']")).toHaveLength(1),
    );
    expect(screen.getByRole("option").textContent).toContain("Payments");
  });

  it("routes a grouped row's option id through the machine", async () => {
    const onChange = vi.fn();
    const lanes = [
      { id: "lane-1", name: "Payments", color: "#ff0000", branchRef: "refs/heads/ade/payments" },
      { id: "lane-2", name: "Search", branchRef: "refs/heads/ade/search", machineId: "m2" },
    ];
    render(
      <Harness
        lanes={lanes}
        machines={[{ id: "m1", name: "This computer" }, { id: "m2", name: "MacBook Pro" }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select lane" }));
    await screen.findByRole("listbox");
    fireEvent.click(screen.getAllByRole("option")[1]!);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(machineLaneOptionId("m2", "lane-2")),
    );
  });
});
