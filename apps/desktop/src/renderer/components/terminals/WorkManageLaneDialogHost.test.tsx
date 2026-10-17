/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { foreignLaneKey } from "../../state/laneMachineRouting";
import type * as ManageLaneDialogModule from "../lanes/ManageLaneDialog";
import { WorkManageLaneDialogHost } from "./WorkManageLaneDialogHost";

// The dialog's own form is out of scope here. The host only needs a way to pick
// what to delete and press Delete, so the stub calls the same props the real
// dialog calls.
vi.mock("../lanes/ManageLaneDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof ManageLaneDialogModule>()),
  ManageLaneDialog: (props: ComponentProps<typeof ManageLaneDialogModule.ManageLaneDialog>) => (
    <div>
      <button
        type="button"
        onClick={() => props.setDeleteSelection({ worktree: true, localBranch: false, remoteBranch: false })}
      >
        Select worktree
      </button>
      <button type="button" onClick={() => props.onDelete()}>Delete lane</button>
    </div>
  ),
}));

const STUDIO_TARGET_ID = "target-mac-studio";
const studioPin: OpenProjectBinding = {
  kind: "remote",
  key: `remote:${STUDIO_TARGET_ID}:project-1`,
  targetId: STUDIO_TARGET_ID,
  runtimeName: "Mac Studio",
  projectId: "project-1",
  rootPath: "/Users/studio/ADE",
  displayName: "ADE",
};

const studioLane: LaneSummary = {
  id: "lane-feature",
  name: "Feature",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "feature",
  worktreePath: "/Users/studio/ADE/.ade/worktrees/feature",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  color: null,
  icon: null,
  tags: [],
  createdAt: "2026-04-22T10:00:00.000Z",
};

describe("WorkManageLaneDialogHost delete on another machine", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ laneDeleteProgressByLaneId: {} });
    Reflect.deleteProperty(window, "ade");
  });

  it.each([
    ["finishes", false],
    ["fails", true],
  ])("shows the lane deleting on its machine until the delete %s", async (_outcome, fails) => {
    let settle: () => void = () => {};
    const deleteLane = vi.fn(() => new Promise<void>((resolve, reject) => {
      settle = fails ? () => reject(new Error("worktree is locked")) : () => resolve();
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { lanes: { list: vi.fn(async () => [studioLane]), delete: deleteLane } },
    });
    const key = foreignLaneKey(STUDIO_TARGET_ID, studioLane.id);

    render(
      <WorkManageLaneDialogHost laneId={studioLane.id} lane={studioLane} runtimePin={studioPin} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete lane" }));

    expect(deleteLane).toHaveBeenCalledWith(expect.objectContaining({ laneId: studioLane.id }), studioPin);
    // Keyed the way the Work sidebar names a lane on another machine. The bare
    // lane id belongs to this machine's lane, so nothing may land there.
    expect(Object.keys(useAppStore.getState().laneDeleteProgressByLaneId)).toEqual([key]);
    expect(useAppStore.getState().laneDeleteProgressByLaneId[key]?.overallStatus).toBe("running");

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(useAppStore.getState().laneDeleteProgressByLaneId).toEqual({}));
  });
});
