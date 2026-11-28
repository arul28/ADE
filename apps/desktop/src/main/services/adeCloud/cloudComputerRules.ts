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

import os from "node:os";
import { AdeExpectedError } from "../../../shared/expectedError";
import { BRAND } from "../../../shared/brand";

/** A DAEX Cloud Mac's id: `mac` and 32 hex (NoMac's; the account server's `macProvider.ts`). */
const CLOUD_MAC_ID = /^mac[0-9a-f]{32}$/;

/** Whether a cloud computer's id is a DAEX Cloud Mac's. */
export function isCloudMacId(id: string): boolean {
  return CLOUD_MAC_ID.test(id);
}

/** Whether this ADE runs on an ADE Cloud computer (the machine template sets the variable): a Linux one or a Mac. */
export function isAdeCloudComputer(env: NodeJS.ProcessEnv = process.env): boolean {
  const id = env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "";
  return /^[a-z0-9]{10}$/.test(id) || CLOUD_MAC_ID.test(id);
}

/** Whether this ADE runs on a DAEX Cloud Mac (its drive's `boot.sh` sets the id). */
export function isAdeCloudMac(env: NodeJS.ProcessEnv = process.env): boolean {
  return CLOUD_MAC_ID.test(env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "");
}

/**
 * The agent prompt's one line, only on an ADE Cloud computer. Without it an
 * agent there did not know it ran on its lane's own cloud computer, read ADE's
 * memory guard stopping a build as a bare "Killed", and never thought to ask
 * for a bigger size, which an agent may do only by asking the person on a card.
 *
 * The one copy: the runtime block of `buildCodingAgentSystemPrompt`
 * (`ai/tools/systemPrompt.ts`) carries it for Claude, Codex, Copilot, Droid,
 * OpenCode and Pi, and `buildAdeGuidanceForLane` (`agentChatService.ts`) for
 * Cursor, Muse and the ACP agents. It lives here, not in `systemPrompt.ts`,
 * because the chat tests replace that module whole.
 */
export function describeAdeCloudComputer(): string | null {
  if (!isAdeCloudComputer()) return null;
  const memoryGb = Math.round(os.totalmem() / 2 ** 30);
  if (isAdeCloudMac()) {
    // A Mac has one size and its own simulator: no resize, and `daex apple` runs here, not on a cloud iPhone.
    return `**DAEX Cloud:** you run on this lane's own DAEX Cloud Mac (macOS, Apple silicon, ${memoryGb} GB memory, Xcode). Keep the repository, build output and caches under \`~/drive\` (the only folder a stop keeps). It stops after a few idle minutes; a running build or test counts as work. \`daex apple\` uses this Mac's own simulator. Device signing and notarization need the person's own Apple account and aren't set up here. Details: **daex-cloud**.`;
  }
  return `**DAEX Cloud:** you run on this lane's own DAEX Cloud computer (Linux, ${memoryGb} GB memory, no swap). A command that ends with "Killed" ran out of memory: DAEX stopped the biggest process to save the computer. For more memory or disk, \`daex cloud resize --request --size <size> --reason "…"\` asks the user on a card. Details: **daex-cloud**.`;
}

/** What a person or an agent reads when a cloud computer refuses a second lane. Stable: the UI and the CLI show it as is. */
const CLOUD_COMPUTER_ONE_LANE_MESSAGE =
  `This ${BRAND.CLOUD_NAME} computer already holds a lane, and each cloud computer holds one. Start a new lane on ${BRAND.CLOUD_NAME} instead: it gets its own computer.`;

/** What a person or an agent reads when two processes make a lane on one cloud computer and the check waited too long. */
export const CLOUD_COMPUTER_LANE_CHECK_BUSY_MESSAGE =
  `${BRAND.NAME} couldn't check the lanes on this ${BRAND.CLOUD_NAME} computer, because another lane is being made here now. Try again in a moment.`;

/**
 * What a person or an agent reads when the lane a cloud computer holds is
 * archived. An archived lane keeps its computer (one-click restore), so the
 * computer is still taken.
 */
function cloudComputerArchivedLaneMessage(laneName: string): string {
  const name = laneName.trim() || "that lane";
  return `This ${BRAND.CLOUD_NAME} computer belongs to the archived lane "${name}". `
    + `Restore that lane to use this computer again, or start a new lane on ${BRAND.CLOUD_NAME}: it gets its own computer.`;
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
