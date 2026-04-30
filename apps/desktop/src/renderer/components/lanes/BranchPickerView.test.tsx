/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchPickerView } from "./BranchPickerView";
import type { LaneBranchOption } from "./laneUtils";
import type { BranchPullRequest } from "../../../shared/types";

vi.mock("@tanstack/react-virtual", () => {
  // Render every row so list assertions don't have to deal with windowing.
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

const NOW_ISO = "2026-04-30T10:00:00Z";

const branches: LaneBranchOption[] = [
  {
    name: "feat/widget",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    lastCommitAuthor: "Arul Sharma",
    lastCommitMessage: "tweak widget alignment",
    lastCommitDate: NOW_ISO,
  },
  {
    name: "feat/sidebar",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    lastCommitAuthor: "Jamie Lee",
    lastCommitMessage: "rebuild sidebar nav",
    lastCommitDate: NOW_ISO,
  },
  {
    name: "release/9.1",
    isCurrent: true,
    isRemote: false,
    upstream: null,
    lastCommitAuthor: "Arul Sharma",
    lastCommitMessage: "bump version",
    lastCommitDate: NOW_ISO,
  },
];

const prs: BranchPullRequest[] = [
  {
    branch: "feat/widget",
    prNumber: 812,
    title: "Add widget alignment options",
    state: "open",
    url: "https://github.com/example/repo/pull/812",
    author: "arulsharma",
    updatedAt: NOW_ISO,
  },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof BranchPickerView>> = {}) {
  return render(
    <BranchPickerView
      branches={branches}
      pullRequests={prs}
      currentUserName="Arul Sharma"
      selectedBranch=""
      onSelect={vi.fn()}
      onConfirm={vi.fn()}
      onBack={vi.fn()}
      {...overrides}
    />,
  );
}

describe("BranchPickerView", () => {
  afterEach(cleanup);

  it("renders all branches with their last-commit metadata and PR pills", () => {
    renderPicker();
    expect(screen.getByText("feat/widget")).toBeTruthy();
    expect(screen.getByText("feat/sidebar")).toBeTruthy();
    expect(screen.getByText("release/9.1")).toBeTruthy();
    expect(screen.getByText("#812")).toBeTruthy();
    expect(screen.getByText(/3 of 3/)).toBeTruthy();
  });

  it("filters by free-text search", () => {
    renderPicker();
    fireEvent.change(screen.getByPlaceholderText(/name . pr:open/), { target: { value: "sidebar" } });
    expect(screen.queryByText("feat/widget")).toBeFalsy();
    expect(screen.getByText("feat/sidebar")).toBeTruthy();
  });

  it("filters by pr:open token", () => {
    renderPicker();
    fireEvent.change(screen.getByPlaceholderText(/name . pr:open/), { target: { value: "pr:open" } });
    expect(screen.getByText("feat/widget")).toBeTruthy();
    expect(screen.queryByText("feat/sidebar")).toBeFalsy();
    expect(screen.queryByText("release/9.1")).toBeFalsy();
  });

  it("filters by mine using current user name", () => {
    renderPicker();
    fireEvent.change(screen.getByPlaceholderText(/name . pr:open/), { target: { value: "mine" } });
    expect(screen.getByText("feat/widget")).toBeTruthy();
    expect(screen.queryByText("feat/sidebar")).toBeFalsy();
    expect(screen.getByText("release/9.1")).toBeTruthy();
  });

  it("invokes onSelect and onConfirm when a row is clicked then confirmed", () => {
    const onSelect = vi.fn();
    const onConfirm = vi.fn();
    renderPicker({ onSelect, onConfirm });
    fireEvent.click(screen.getByText("feat/widget"));
    expect(onSelect).toHaveBeenCalledWith("feat/widget");

    cleanup();
    const onConfirm2 = vi.fn();
    renderPicker({ selectedBranch: "feat/widget", onConfirm: onConfirm2 });
    fireEvent.click(screen.getByRole("button", { name: "Use this branch" }));
    expect(onConfirm2).toHaveBeenCalled();
  });

  it("Enter on the search input picks the first filtered row", () => {
    const onSelect = vi.fn();
    const onConfirm = vi.fn();
    renderPicker({ onSelect, onConfirm });
    const input = screen.getByPlaceholderText(/name . pr:open/);
    fireEvent.change(input, { target: { value: "sidebar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("feat/sidebar");
    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onBack when the back button is clicked", () => {
    const onBack = vi.fn();
    renderPicker({ onBack });
    fireEvent.click(screen.getByLabelText("Back to lane setup"));
    expect(onBack).toHaveBeenCalled();
  });

  it("shows an empty-state message when no branches match", () => {
    renderPicker();
    fireEvent.change(screen.getByPlaceholderText(/name . pr:open/), { target: { value: "nopenope" } });
    expect(screen.getByText("No branches match your search.")).toBeTruthy();
  });
});
