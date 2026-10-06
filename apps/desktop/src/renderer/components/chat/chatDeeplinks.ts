import type { DeeplinkTarget } from "../../../shared/deeplinks";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";
import { navigateToAppTarget, openAdeDeeplink } from "../../lib/openExternal";
import { rootAppStoreApi } from "../../state/appStore";
import { machineEntryForBinding } from "../../state/crossMachineLanes";
import type { ChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * Opening the `ade://` links that appear inside a chat — a chip in a reply, a
 * link in a scene — against that chat's lane and machine rather than the tab's.
 */

/**
 * The machine that holds the chat's lane, or null when the chat runs on the
 * tab's own machine. Read on click, so a transcript of pills holds no extra
 * store subscription. Before the union has read that machine, the pin still
 * names it: a remote pin by its target id, a local pin as This computer (a
 * local pin only exists while the tab is bound to a remote machine).
 */
export function chatMachineId(scope: Pick<ChatRuntimeScope, "pin">): string | null {
  const pin = scope.pin;
  if (!pin) return null;
  return machineEntryForBinding(rootAppStoreApi.getState(), pin)?.machineId
    ?? (pin.kind === "remote" ? pin.targetId : THIS_MACHINE_ID);
}

/**
 * Open an `ade://` link that appeared in a chat (a chip, a scene), resolved
 * against that chat's lane and machine rather than the tab's.
 */
export function openChatDeeplinkTarget(
  url: string,
  target: DeeplinkTarget,
  scope: Pick<ChatRuntimeScope, "laneId" | "pin">,
): void {
  // A bare SHA in a reply names no lane. It is a commit of the lane this chat
  // works in, on the machine this chat runs on. Without that, the click has
  // nothing to open and shows the "lives on another machine" modal.
  if (target.kind === "commit" && !target.laneId && scope.laneId) {
    navigateToAppTarget({ kind: "commit", sha: target.sha, laneId: scope.laneId, machineId: chatMachineId(scope) });
    return;
  }
  // A commit that names its own lane (a chip carrying one) still belongs to the
  // chat's machine: the generic route would resolve the lane against the tab's,
  // where a same-id local lane could win before the chat's remote one.
  if (target.kind === "commit" && target.laneId) {
    navigateToAppTarget({
      kind: "commit",
      sha: target.sha,
      laneId: target.laneId,
      machineId: chatMachineId(scope),
      envelope: target.envelope ?? null,
    });
    return;
  }
  // `#1407` in an agent's reply names a PR with no repo. A deeplink must name
  // the repo to parse, so that one opens through the in-app PR route, which
  // resolves the number against this project's PRs.
  if (target.kind === "pr" && !target.repoOwner) {
    navigateToAppTarget({ kind: "pr", prNumber: target.prNumber });
    return;
  }
  // A lane id names a lane on the chat's machine; a pinned chat's lane is not
  // in the tab's own lane list.
  if (target.kind === "lane") {
    navigateToAppTarget({ kind: "lane", laneId: target.laneId, machineId: chatMachineId(scope), envelope: target.envelope ?? null });
    return;
  }
  openAdeDeeplink(url);
}
