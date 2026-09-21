/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import {
  APPLE_INSTALL_RUNTIME_COMMAND,
  AppleDeviceCreateDialog,
  groupInstalledSimulators,
  proposeCloneName,
  sortAttachCandidates,
} from "./AppleDeviceCreateDialog";

function simulator(overrides: Partial<AppleInstalledSimulator> = {}): AppleInstalledSimulator {
  return {
    udid: "A",
    name: "iPhone 17",
    runtime: "iOS 26.0",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: null,
    ...overrides,
  };
}

describe("groupInstalledSimulators", () => {
  it("groups by family, iPhone first, newest runtime first", () => {
    const groups = groupInstalledSimulators([
      simulator({ udid: "ipad", name: "iPad Pro", family: "ipad", runtime: "iOS 26.0" }),
      simulator({ udid: "old", name: "iPhone 12", runtime: "iOS 18.0" }),
      simulator({ udid: "new", name: "iPhone 17", runtime: "iOS 26.0" }),
    ]);
    expect(groups.map((group) => group.family)).toEqual(["iphone", "ipad"]);
    // `simctl` returns device-type order, which puts an iPhone 12 above an
    // iPhone 17 — the one ordering a picker must not inherit.
    expect(groups[0]?.simulators.map((entry) => entry.udid)).toEqual(["new", "old"]);
  });

  it("drops empty families instead of showing an empty heading", () => {
    expect(groupInstalledSimulators([simulator()]).map((group) => group.family)).toEqual(["iphone"]);
  });
});

describe("sortAttachCandidates", () => {
  it("puts booted simulators first", () => {
    const rows = sortAttachCandidates([
      simulator({ udid: "cold", runtime: "iOS 26.0" }),
      simulator({ udid: "hot", runtime: "iOS 18.0", state: "Booted" }),
    ]);
    expect(rows[0]?.udid).toBe("hot");
  });
});

describe("proposeCloneName", () => {
  it("joins the source and the lane", () => {
    expect(proposeCloneName("iPhone 17", "lane-ab3")).toBe("iPhone 17 — lane-ab3");
  });

  it("truncates at 60 characters", () => {
    const name = proposeCloneName("x".repeat(80), "lane");
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("…")).toBe(true);
  });
});

afterEach(cleanup);

describe("AppleDeviceCreateDialog", () => {
  it("names Xcode ▸ Settings ▸ Components and never offers a download", async () => {
    const onCopy = vi.fn();
    render(
      <AppleDeviceCreateDialog
        laneName="lane-ab3"
        installed={[]}
        lastUsedUdid={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onCopyInstallCommand={onCopy}
      />,
    );
    expect(screen.getByText(/Xcode ▸ Settings ▸ Components/u)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
    // ADE never downloads a runtime itself; it hands the user the command.
    expect(onCopy).toHaveBeenCalledWith(APPLE_INSTALL_RUNTIME_COMMAND);
  });

  it("pre-selects the project's last-used source and submits it as a clone", async () => {
    const onSubmit = vi.fn();
    render(
      <AppleDeviceCreateDialog
        laneName="lane-ab3"
        installed={[simulator({ udid: "A", name: "iPhone 12", runtime: "iOS 18.0" }), simulator({ udid: "B", name: "iPhone 17" })]}
        lastUsedUdid="A"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "clone", simulator: "A" });
  });

  it("falls back to the newest installed iPhone with no history", async () => {
    const onSubmit = vi.fn();
    render(
      <AppleDeviceCreateDialog
        laneName="lane-ab3"
        installed={[
          simulator({ udid: "ipad", family: "ipad", name: "iPad Pro", runtime: "iOS 26.0" }),
          simulator({ udid: "old", name: "iPhone 12", runtime: "iOS 18.0" }),
          simulator({ udid: "new", name: "iPhone 17", runtime: "iOS 26.0" }),
        ]}
        lastUsedUdid={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "clone", simulator: "new" });
  });

  it("warns that an attached simulator is shared with the lane already using it", async () => {
    render(
      <AppleDeviceCreateDialog
        laneName="lane-ab3"
        installed={[simulator({ udid: "A" })]}
        lastUsedUdid={null}
        inUseByLane={{ A: "lane-cc1" }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getAllByRole("radio")[1]!);
    expect(screen.getByText(/Changes affect both/u)).toBeTruthy();
  });

  it("switches the primary button to Attach in attach mode", async () => {
    const onSubmit = vi.fn();
    render(
      <AppleDeviceCreateDialog
        laneName="lane-ab3"
        installed={[simulator({ udid: "A" })]}
        lastUsedUdid={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getAllByRole("radio")[1]!);
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "attach", simulator: "A" });
  });
});
