/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { HistoryLanePicker, type HistoryLanePickerGroup } from "./HistoryLanePicker";

afterEach(cleanup);

function lane(id: string, name: string, laneType: LaneSummary["laneType"] = "worktree"): LaneSummary {
  return {
    id,
    name,
    laneType,
    baseRef: "main",
    branchRef: `ade/${id}`,
    worktreePath: `/tmp/${id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    lastCommitAt: "2026-01-01T00:00:00Z",
  };
}

function groups(): HistoryLanePickerGroup[] {
  return [{
    key: "current",
    machineName: "",
    disabledReason: null,
    options: [
      { value: "lane-a", lane: lane("lane-a", "Lane A") },
      { value: "lane-b", lane: lane("lane-b", "Lane B") },
    ],
  }];
}

describe("HistoryLanePicker focus return", () => {
  it("hands focus back to the trigger after a keyboard pick", async () => {
    const onChange = vi.fn();
    render(<HistoryLanePicker value="lane-a" groups={groups()} onChange={onChange} />);
    const trigger = screen.getByTestId("history-lane-picker");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = await screen.findByRole("menuitem", { name: /Lane B/ });
    fireEvent.keyDown(item, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("lane-b");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not leave a focus ring on the trigger after a mouse pick", async () => {
    const onChange = vi.fn();
    render(<HistoryLanePicker value="lane-a" groups={groups()} onChange={onChange} />);
    const trigger = screen.getByTestId("history-lane-picker");

    // jsdom cannot open a Radix menu from a pointer event, so the menu is
    // opened by keyboard and the POINTER makes the pick. The pick is the input
    // that decides focus return, which is the contract under test.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = await screen.findByRole("menuitem", { name: /Lane B/ });
    fireEvent.pointerDown(item);
    fireEvent.click(item);

    expect(onChange).toHaveBeenCalledWith("lane-b");
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  });
});
