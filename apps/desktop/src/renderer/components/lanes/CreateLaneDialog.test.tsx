/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRuntimePlacement, LaneSummary } from "../../../shared/types";
import { CreateLaneDialog } from "./CreateLaneDialog";

afterEach(cleanup);

type DialogProps = Parameters<typeof CreateLaneDialog>[0];

function makeProps(overrides: Partial<DialogProps> = {}): DialogProps {
  const setRuntimePlacement = vi.fn();
  return {
    open: true,
    onOpenChange: vi.fn(),
    createLaneName: "lane-x",
    setCreateLaneName: vi.fn(),
    createMode: "primary",
    setCreateMode: vi.fn(),
    createParentLaneId: "",
    setCreateParentLaneId: vi.fn(),
    createBaseBranch: "main",
    setCreateBaseBranch: vi.fn(),
    createImportBranch: "",
    setCreateImportBranch: vi.fn(),
    createChildBaseBranch: "",
    setCreateChildBaseBranch: vi.fn(),
    runtimePlacement: "local" as LaneRuntimePlacement,
    setRuntimePlacement,
    vmRuntimeAvailable: false,
    vmRuntimeUnavailableReason: "Set up your Mac VM first.",
    vmRuntimeGateKind: "vm-setup",
    existingVmLane: null,
    onOpenVmTab: vi.fn(),
    onOpenVmLaneInWork: vi.fn(),
    createBranches: [
      { name: "main", isRemote: false, isCurrent: true, lastCommitAuthor: "x", lastCommitDate: "" } as any,
    ],
    lanes: [],
    onSubmit: vi.fn(),
    busy: false,
    error: null,
    envInitProgress: null,
    setupSteps: [],
    templates: [],
    selectedTemplateId: "",
    setSelectedTemplateId: vi.fn(),
    selectedColor: "#999",
    setSelectedColor: vi.fn(),
    selectedLinearIssue: null,
    setSelectedLinearIssue: vi.fn(),
    branchPullRequests: [],
    currentGitUserName: "tester",
    loadingBranches: false,
    loadingBranchPullRequests: false,
    ...overrides,
  };
}

describe("CreateLaneDialog VM-lane gate", () => {
  it("disables the Mac VM radio and shows the setup CTA when no VM exists", () => {
    const onOpenVmTab = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CreateLaneDialog
        {...makeProps({
          vmRuntimeAvailable: false,
          vmRuntimeUnavailableReason: "Set up your Mac VM first.",
          vmRuntimeGateKind: "vm-setup",
          existingVmLane: null,
          onOpenVmTab,
          onOpenChange,
        })}
      />,
    );

    const vmRadio = screen.getByTestId("create-lane-vm-radio") as HTMLButtonElement;
    expect(vmRadio.disabled).toBe(true);

    expect(screen.getByTestId("create-lane-vm-gate").textContent).toContain(
      "Set up your Mac VM first.",
    );
    fireEvent.click(screen.getByTestId("create-lane-vm-gate-cta"));
    expect(onOpenVmTab).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables the Mac VM radio and shows the phase reason when the VM is not runtime_ready", () => {
    render(
      <CreateLaneDialog
        {...makeProps({
          vmRuntimeAvailable: false,
          vmRuntimeUnavailableReason: "Finish Mac VM setup first (current phase: First-boot setup).",
          vmRuntimeGateKind: "vm-setup",
          existingVmLane: null,
          onOpenVmTab: vi.fn(),
        })}
      />,
    );

    expect((screen.getByTestId("create-lane-vm-radio") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("create-lane-vm-gate").textContent).toContain(
      "Finish Mac VM setup first (current phase: First-boot setup).",
    );
    expect(screen.getByTestId("create-lane-vm-gate-cta").textContent).toContain("Open VM tab");
  });

  it("shows the Open-in-Work CTA when a VM lane already exists", () => {
    const onOpenVmLaneInWork = vi.fn();
    const onOpenChange = vi.fn();
    const existingVmLane = {
      id: "lane-vm-x",
      name: "vm-lane-x",
      runtimePlacement: "macos-vm",
    } as unknown as LaneSummary;

    render(
      <CreateLaneDialog
        {...makeProps({
          vmRuntimeAvailable: false,
          vmRuntimeUnavailableReason: `A VM lane already exists: ${existingVmLane.name}.`,
          vmRuntimeGateKind: "existing-vm-lane",
          existingVmLane,
          onOpenVmLaneInWork,
          onOpenChange,
        })}
      />,
    );

    expect((screen.getByTestId("create-lane-vm-radio") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("create-lane-vm-gate").textContent).toContain(
      "A VM lane already exists: vm-lane-x.",
    );
    fireEvent.click(screen.getByTestId("create-lane-vm-gate-cta"));
    expect(onOpenVmLaneInWork).toHaveBeenCalledWith("lane-vm-x");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("enables the Mac VM radio and hides the gate when the VM is ready", () => {
    render(
      <CreateLaneDialog
        {...makeProps({
          vmRuntimeAvailable: true,
          vmRuntimeUnavailableReason: null,
          vmRuntimeGateKind: "none",
        })}
      />,
    );

    const vmRadio = screen.getByTestId("create-lane-vm-radio") as HTMLButtonElement;
    expect(vmRadio.disabled).toBe(false);
    expect(screen.queryByTestId("create-lane-vm-gate")).toBeNull();
  });
});
