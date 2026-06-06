/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneRuntimePlacement, LaneSummary } from "../../../shared/types";
import { CreateLaneDialog } from "./CreateLaneDialog";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

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
  it("describes the default runtime as the local Mac", () => {
    render(<CreateLaneDialog {...makeProps()} />);

    expect(screen.getByText("Local Mac")).toBeTruthy();
    expect(screen.getByText("Use this ADE runtime and local worktree.")).toBeTruthy();
  });

  it("uses the provided runtime copy for a remote project", () => {
    render(
      <CreateLaneDialog
        {...makeProps({
          localRuntimeLabel: "Mac Studio",
          localRuntimeDescription: "Use this connected remote ADE runtime and remote worktree.",
        })}
      />,
    );

    expect(screen.getByText("Mac Studio")).toBeTruthy();
    expect(screen.getByText("Use this connected remote ADE runtime and remote worktree.")).toBeTruthy();
    expect(screen.queryByText("Use this ADE runtime and local worktree.")).toBeNull();
  });

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

  it("opens the shared Linear issue browser as its own modal", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        cto: {
          getLinearIssuePickerData: vi.fn(async () => ({
            projects: [],
            users: [],
            states: [],
          })),
          searchLinearIssues: vi.fn(async () => ({
            issues: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          })),
        },
      },
    });

    render(<CreateLaneDialog {...makeProps()} />);

    fireEvent.click(screen.getByRole("button", { name: /connect a linear issue/i }));

    expect(await screen.findByRole("dialog", { name: "Connect Linear issue" })).toBeTruthy();
    expect(screen.queryByText("Lane name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Connect Linear issue backdrop" }));
    expect(await screen.findByText("Lane name")).toBeTruthy();
  });
});
