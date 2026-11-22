import { showToast } from "../components/app/toast/toastStore";
import type { OpenProjectBinding } from "../../shared/types";
import { requirePin } from "./requirePin";

/**
 * Reveal a lane's stored worktree on the lane's machine (`pin`). The main
 * process resolves the path from the lane id.
 */
export async function revealLaneWorktree(laneId: string, pin: OpenProjectBinding | null): Promise<void> {
  try {
    await window.ade.lanes.revealWorktree({ laneId }, requirePin(pin, "No computer with this lane is online."));
  } catch (error) {
    showToast({
      title: "Could not reveal the lane folder",
      message: error instanceof Error ? error.message : String(error),
      tone: "error",
    });
  }
}
