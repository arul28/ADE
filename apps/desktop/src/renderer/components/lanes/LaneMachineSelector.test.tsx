/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaneMachineSelector } from "./LaneMachineSelector";
import { THIS_MACHINE_ID, type LaneMachineOption } from "./laneMachines";

afterEach(cleanup);

function machine(overrides: Partial<LaneMachineOption> & { id: string; name: string }): LaneMachineOption {
  return {
    targetId: overrides.id === THIS_MACHINE_ID ? null : overrides.id,
    hostname: null,
    version: null,
    freeBytes: null,
    repoMatch: "matched",
    project: null,
    isBound: false,
    ...overrides,
  };
}

const machines: LaneMachineOption[] = [
  machine({ id: THIS_MACHINE_ID, name: "This Mac", isBound: true, freeBytes: 412 * 1024 ** 3 }),
  machine({ id: "studio", name: "MacBook Pro (97)", freeBytes: 4 * 1024 ** 3 }),
];

describe("LaneMachineSelector", () => {
  it("names machines absolutely and never calls one 'remote'", () => {
    render(
      <LaneMachineSelector
        machines={machines}
        selectedMachineId={THIS_MACHINE_ID}
        onSelectMachine={vi.fn()}
      />,
    );

    expect(screen.getByText("Create on")).toBeTruthy();
    expect(screen.getByText("This Mac")).toBeTruthy();
    expect(screen.getByText("MacBook Pro (97)")).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Machine for this lane" });
    expect(group.textContent?.toLowerCase()).not.toContain("remote");
  });

  it("marks the selected machine and reports free disk headroom", () => {
    render(
      <LaneMachineSelector
        machines={machines}
        selectedMachineId={THIS_MACHINE_ID}
        onSelectMachine={vi.fn()}
      />,
    );

    const [thisMac, studio] = screen.getAllByRole("radio");
    expect(thisMac?.getAttribute("aria-checked")).toBe("true");
    expect(studio?.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("412 GB free")).toBeTruthy();
    expect(screen.getByText("4.0 GB free")).toBeTruthy();
  });

  it("omits the size when a machine doesn't report free space", () => {
    render(
      <LaneMachineSelector
        machines={[machines[0]!, machine({ id: "mini", name: "Mac mini" })]}
        selectedMachineId={THIS_MACHINE_ID}
        onSelectMachine={vi.fn()}
      />,
    );

    expect(screen.queryByText(/free$/)).toBeTruthy();
    expect(screen.queryAllByText(/ free$/)).toHaveLength(1);
  });

  it("selects a machine on click", () => {
    const onSelectMachine = vi.fn();
    render(
      <LaneMachineSelector
        machines={machines}
        selectedMachineId={THIS_MACHINE_ID}
        onSelectMachine={onSelectMachine}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /MacBook Pro \(97\)/ }));
    expect(onSelectMachine).toHaveBeenCalledWith("studio");
  });

  it("blocks machines that don't have this repo", () => {
    const onSelectMachine = vi.fn();
    render(
      <LaneMachineSelector
        machines={[
          machines[0]!,
          machine({ id: "mini", name: "Mac mini", repoMatch: "missing" }),
        ]}
        selectedMachineId={THIS_MACHINE_ID}
        onSelectMachine={onSelectMachine}
      />,
    );

    const mini = screen.getByRole("radio", { name: /Mac mini/ }) as HTMLButtonElement;
    expect(mini.disabled).toBe(true);
    fireEvent.click(mini);
    expect(onSelectMachine).not.toHaveBeenCalled();
    expect(screen.getByText("This repo isn't here yet")).toBeTruthy();
  });

  it("offers connecting another machine", () => {
    const onConnectMachine = vi.fn();
    render(
      <LaneMachineSelector
        machines={machines}
        selectedMachineId={THIS_MACHINE_ID}
        onSelectMachine={vi.fn()}
        onConnectMachine={onConnectMachine}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /connect another machine/i }));
    expect(onConnectMachine).toHaveBeenCalledTimes(1);
  });
});
