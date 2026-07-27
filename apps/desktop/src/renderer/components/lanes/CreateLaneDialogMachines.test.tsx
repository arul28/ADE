/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateLaneDialog } from "./CreateLaneDialog";
import { THIS_MACHINE_ID, type LaneMachineOption } from "./laneMachines";

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
  return {
    open: true,
    onOpenChange: vi.fn(),
    createLaneName: "lane-x",
    setCreateLaneName: vi.fn(),
    createMode: "primary",
    setCreateMode: vi.fn(),
    createParentLaneId: "",
    setCreateParentLaneId: vi.fn(),
    createBaseSource: "remote",
    setCreateBaseSource: vi.fn(),
    createBaseBranch: "origin/main",
    setCreateBaseBranch: vi.fn(),
    createImportBranch: "",
    setCreateImportBranch: vi.fn(),
    createChildBaseBranch: "",
    setCreateChildBaseBranch: vi.fn(),
    createBranches: [
      { name: "main", isRemote: false, isCurrent: true, upstream: "origin/main", lastCommitAuthor: "x", lastCommitDate: "" } as any,
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

const thisMac = machine({ id: THIS_MACHINE_ID, name: "This Mac", isBound: true });
const studio = machine({ id: "studio", name: "MacBook Pro (97)" });

describe("CreateLaneDialog machine selection", () => {
  it("renders exactly as before when only one machine is connected", () => {
    render(
      <CreateLaneDialog
        {...makeProps({ machines: [thisMac], selectedMachineId: THIS_MACHINE_ID, onSelectMachine: vi.fn() })}
      />,
    );

    expect(screen.queryByText("Create on")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Machine for this lane" })).toBeNull();
    // The git base-source control is untouched.
    expect(screen.getByText("Use fetched upstream")).toBeTruthy();
  });

  it("shows the machine selector once a second machine is connected", () => {
    const onSelectMachine = vi.fn();
    render(
      <CreateLaneDialog
        {...makeProps({
          machines: [thisMac, studio],
          selectedMachineId: THIS_MACHINE_ID,
          onSelectMachine,
        })}
      />,
    );

    expect(screen.getByText("Create on")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /MacBook Pro \(97\)/ }));
    expect(onSelectMachine).toHaveBeenCalledWith("studio");
  });

  it("keeps the machine vocabulary separate from the git base-source cards", () => {
    render(
      <CreateLaneDialog
        {...makeProps({
          machines: [thisMac, studio],
          selectedMachineId: THIS_MACHINE_ID,
          onSelectMachine: vi.fn(),
        })}
      />,
    );

    // "Remote"/"Local" still mean the base-branch source, and the machine
    // selector borrows neither word.
    expect(screen.getByText("Use fetched upstream")).toBeTruthy();
    expect(screen.getByText("Use your local branch tip")).toBeTruthy();
    const machineGroup = screen.getByRole("radiogroup", { name: "Machine for this lane" });
    expect(machineGroup.textContent).not.toMatch(/remote|local/i);
  });

  it("locks machine choice while a lane is being created", () => {
    render(
      <CreateLaneDialog
        {...makeProps({
          busy: true,
          machines: [thisMac, studio],
          selectedMachineId: THIS_MACHINE_ID,
          onSelectMachine: vi.fn(),
        })}
      />,
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
