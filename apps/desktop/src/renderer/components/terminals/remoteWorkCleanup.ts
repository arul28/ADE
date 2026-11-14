import type { RemoteWorkPin } from "../../lib/remoteWorkPins";
import { remoteWorkReadErrorText } from "../../lib/remoteWorkPins";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import { showToast } from "../app/toast/toastStore";
import { joinNames, type LeftoverMachine } from "./workToolCatalog";

/**
 * The tools pane's one Clean up: deletes this chat's code on each machine it
 * left work on, and everything that copy held there (its simulator session,
 * emulator, screen and app), as `ade shell clean --machine <name>` does.
 *
 * A person's action, so it goes as theirs: `remote_work.list` then
 * `remote_work.delete` on THAT machine, through the pin this window holds for
 * it (the same calls Settings › Machines makes). A machine this window has no
 * connection to is said, not connected behind the person's back. Returns the
 * machine keys it cleaned.
 */
export async function cleanUpRemoteWork(args: {
  sessionId: string;
  leftovers: readonly LeftoverMachine[];
  resolvePin: (use: AgentChatRemoteWorkUse) => RemoteWorkPin;
}): Promise<string[]> {
  const api = window.ade?.remoteWork;
  if (!api?.list || !api.delete) {
    showToast({ tone: "error", title: "Clean up isn't available here", message: "Run ade shell clean --machine <name> from the chat instead.", report: false });
    return [];
  }
  const cleaned: string[] = [];
  const unreachable: string[] = [];
  const failed: string[] = [];
  for (const { use } of args.leftovers) {
    const pin = args.resolvePin(use);
    if (pin === "unreachable") {
      unreachable.push(use.machineName);
      continue;
    }
    try {
      const copies = await api.list(pin);
      // Only the copies in the project the pin names: a delete goes through its own project.
      const mine = copies.filter((copy) => copy.chatSessionId === args.sessionId
        && (!use.projectId || copy.projectId === use.projectId));
      for (const copy of mine) {
        await api.delete({ owner: copy.owner, projectId: copy.projectId }, pin);
      }
      cleaned.push(use.machineKey);
    } catch (error) {
      failed.push(`${use.machineName}: ${remoteWorkReadErrorText(error, use.machineName)}`);
    }
  }
  if (cleaned.length) {
    const names = args.leftovers.filter(({ use }) => cleaned.includes(use.machineKey)).map(({ use }) => use.machineName);
    showToast({ tone: "success", title: `Cleaned up ${joinNames(names)}`, message: "This chat's code there, and what it held, is gone." });
  }
  if (unreachable.length) {
    showToast({
      tone: "warning",
      title: `Can't reach ${joinNames(unreachable)} from this window`,
      message: "Connect it in Connections, then clean up again.",
    });
  }
  if (failed.length) {
    // A machine that refused or went away is not an ADE fault: not reported.
    showToast({ tone: "error", title: "Couldn't clean up", message: failed.join("\n"), report: false });
  }
  return cleaned;
}
