import { showToast } from "../components/app/toast/toastStore";

/** Reveal a lane's stored worktree. The main process resolves the path from the lane id. */
export async function revealLaneWorktree(laneId: string): Promise<void> {
  try {
    await window.ade.lanes.revealWorktree({ laneId });
  } catch (error) {
    showToast({
      title: "Could not reveal the lane folder",
      message: error instanceof Error ? error.message : String(error),
      tone: "error",
    });
  }
}
