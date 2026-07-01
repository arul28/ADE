/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateLaneDialog } from "./CreateLaneDialog";

vi.mock("@tanstack/react-virtual", () => {
  return {
    useVirtualizer: ({ count }: { count: number }) => ({
      getTotalSize: () => count * 64,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          start: index * 64,
          size: 64,
          end: (index + 1) * 64,
          key: index,
          lane: 0,
        })),
      measureElement: () => undefined,
    }),
  };
});

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

const importBranches = [
  { name: "origin/feature/import-me", isRemote: true, isCurrent: false, upstream: null, lastCommitAuthor: "x", lastCommitDate: "" } as any,
  { name: "origin/feature/other", isRemote: true, isCurrent: false, upstream: null, lastCommitAuthor: "x", lastCommitDate: "" } as any,
];

const linearIssue = {
  id: "issue-1",
  identifier: "ADE-321",
  title: "Follow up",
} as any;

function StatefulCreateLaneDialog(overrides: Partial<DialogProps> = {}) {
  const [name, setName] = React.useState(overrides.createLaneName ?? "");
  const [mode, setMode] = React.useState<DialogProps["createMode"]>(overrides.createMode ?? "existing");
  const [importBranch, setImportBranch] = React.useState(overrides.createImportBranch ?? "");

  return (
    <CreateLaneDialog
      {...makeProps({
        ...overrides,
        createLaneName: name,
        setCreateLaneName: setName,
        createMode: mode,
        setCreateMode: setMode,
        createImportBranch: importBranch,
        setCreateImportBranch: setImportBranch,
      })}
    />
  );
}

function selectImportBranch(branchName: string) {
  fireEvent.click(screen.getByRole("button", { name: "Choose import branch" }));
  fireEvent.click(screen.getByText(branchName));
  fireEvent.click(screen.getByRole("button", { name: "Use this branch" }));
}

function laneNameInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Lane name" }) as HTMLInputElement;
}

describe("CreateLaneDialog", () => {
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

  it("keeps the base-source selector visible when the selected source has no options", () => {
    render(
      <CreateLaneDialog
        {...makeProps({
          createBaseSource: "remote",
          createBaseBranch: "",
          createBranches: [
            { name: "main", isRemote: false, isCurrent: true, upstream: null } as any,
          ],
        })}
      />,
    );

    expect(screen.getByText("Use fetched upstream")).toBeTruthy();
    expect(screen.getByText("Use your local branch tip")).toBeTruthy();
    expect(screen.getByText("No remote-tracking refs found.")).toBeTruthy();
  });

  it("disables submit while the selected base branch is stale for the current source", () => {
    const onSubmit = vi.fn();
    render(
      <CreateLaneDialog
        {...makeProps({
          onSubmit,
          createBaseSource: "local",
          createBaseBranch: "origin/main",
          createBranches: [
            { name: "main", isRemote: false, isCurrent: true, upstream: "origin/main", lastCommitAuthor: "x", lastCommitDate: "" } as any,
          ],
        })}
      />,
    );

    const submit = screen.getByRole("button", { name: "Create from origin/main" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("auto-fills the lane name from the selected remote import branch", () => {
    render(
      <StatefulCreateLaneDialog
        createBranches={importBranches}
      />,
    );

    selectImportBranch("origin/feature/import-me");
    expect(laneNameInput().value).toBe("feature/import-me");

    selectImportBranch("origin/feature/other");
    expect(laneNameInput().value).toBe("feature/other");
  });

  it("does not overwrite a custom lane name when the import branch changes", () => {
    render(
      <StatefulCreateLaneDialog
        createBranches={importBranches}
      />,
    );

    selectImportBranch("origin/feature/import-me");
    fireEvent.change(laneNameInput(), {
      target: { value: "Custom lane name" },
    });

    selectImportBranch("origin/feature/other");
    expect(laneNameInput().value).toBe("Custom lane name");
  });

  it("lets Linear issue naming replace an untouched import-branch default", () => {
    const { rerender } = render(
      <StatefulCreateLaneDialog
        createBranches={importBranches}
      />,
    );

    selectImportBranch("origin/feature/import-me");

    rerender(
      <StatefulCreateLaneDialog
        createBranches={importBranches}
        selectedLinearIssue={linearIssue}
      />,
    );

    expect(laneNameInput().value).toBe("ADE-321 Follow up");
  });
});
