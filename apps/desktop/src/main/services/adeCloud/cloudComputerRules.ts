/**
 * The rules that hold only on an ADE Cloud computer.
 *
 * A cloud computer knows it is one from `ADE_CLOUD_INSTANCE_ID`: the machine
 * template sets it to the computer's 10-character id before ADE starts. Every
 * check reads the variable at call time, so a normal computer (no variable)
 * never meets these rules, on macOS, Windows and Linux alike.
 *
 * - One lane per cloud computer, across every project on it: people manage
 *   lanes, not computers, so a new lane gets its own computer. An archived
 *   lane still holds its computer. The check runs where a lane row comes to
 *   exist (`laneService.ts`), with the computer-wide count in
 *   `cloudComputerLaneHold.ts`. Every sentence it can give is in this file.
 * - Codex runs with full access there: the computer itself is the sandbox
 *   (`agentChatService.ts`).
 */

import { AdeExpectedError } from "../../../shared/expectedError";

/** Whether this ADE runs on an ADE Cloud computer (the machine template sets the variable). */
export function isAdeCloudComputer(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^[a-z0-9]{10}$/.test(env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "");
}

/** What a person or an agent reads when a cloud computer refuses a second lane. Stable: the UI and the CLI show it as is. */
export const CLOUD_COMPUTER_ONE_LANE_MESSAGE =
  "This ADE Cloud computer already holds a lane, and each cloud computer holds one. Start a new lane on ADE Cloud instead: it gets its own computer.";

/** What a person or an agent reads when two processes make a lane on one cloud computer and the check waited too long. */
export const CLOUD_COMPUTER_LANE_CHECK_BUSY_MESSAGE =
  "ADE couldn't check the lanes on this ADE Cloud computer, because another lane is being made here now. Try again in a moment.";

/**
 * What a person or an agent reads when the lane a cloud computer holds is
 * archived. An archived lane keeps its computer (one-click restore), so the
 * computer is still taken.
 */
export function cloudComputerArchivedLaneMessage(laneName: string): string {
  const name = laneName.trim() || "that lane";
  return `This ADE Cloud computer belongs to the archived lane "${name}". `
    + "Restore that lane to use this computer again, or start a new lane on ADE Cloud: it gets its own computer.";
}

/**
 * A new lane refused on a cloud computer that already holds one (active, or
 * archived when `archivedLaneName` is set). An answer, not a bug (`user`), so
 * no Sentry issue. No `name` or `code` of its own: the message crosses IPC
 * and JSON-RPC unchanged.
 */
export class CloudComputerLaneLimitError extends AdeExpectedError {
  readonly cloudComputerLaneLimit = true;
  constructor(archivedLaneName?: string | null) {
    super(archivedLaneName != null ? cloudComputerArchivedLaneMessage(archivedLaneName) : CLOUD_COMPUTER_ONE_LANE_MESSAGE, "user");
  }
}
