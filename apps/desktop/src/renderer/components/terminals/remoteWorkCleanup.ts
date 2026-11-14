import type { RemoteWorkPin } from "../../lib/remoteWorkPins";
import { remoteWorkReadErrorText } from "../../lib/remoteWorkPins";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import type { RemoteWorkCopyListing } from "../../../shared/types/remoteWork";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { joinNames, type LeftoverMachine } from "./workToolCatalog";

/**
 * The tools pane's one Clean up: deletes this chat's code on each machine it
 * left work on, and everything that copy held there (its simulator session,
 * emulator, screen and app), as `ade shell clean --machine <name>` does.
 *
 * A person's action, so it goes as theirs: `remote_work.list` then
 * `remote_work.delete` on THAT machine, through the pin this window holds for
 * it (the same calls Settings › Machines makes). A machine this window has no
 * connection to is said, not connected behind the person's back.
 *
 * Never loses work: every delete asks the machine to keep a copy that holds
 * work nobody pushed (`keepUnsynced`), and such a copy is named with its
 * reason and where to delete it on purpose (Settings › Machines, which asks
 * first). A machine can hold the chat's code in more than one checkout of the
 * repository; each copy is deleted through its own project there. Returns the
 * machine keys where nothing of this chat's is left.
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
  const clean: string[] = [];
  const deletedOn: string[] = [];
  const emptyOn: string[] = [];
  const unreachable: string[] = [];
  const kept: string[] = [];
  const failed: string[] = [];
  for (const { use } of args.leftovers) {
    const pin = args.resolvePin(use);
    if (pin === "unreachable") {
      unreachable.push(use.machineName);
      continue;
    }
    let copies: RemoteWorkCopyListing[];
    try {
      // The whole machine's copies: this chat's may sit in another checkout of the repository there.
      copies = (await api.list(pin)).filter((copy) => copy.chatSessionId === args.sessionId);
    } catch (error) {
      failed.push(`${use.machineName}: ${remoteWorkReadErrorText(error, use.machineName)}`);
      continue;
    }
    let deleted = 0;
    let remaining = 0;
    for (const copy of copies) {
      const where = `${use.machineName} (${copy.projectRoot})`;
      // An older ADE there ignores `keepUnsynced` and would delete unpushed work.
      if (copy.keepsUnsynced !== true) {
        remaining += 1;
        failed.push(`${where}: update ADE there to clean up from here, or delete it in Settings › Machines.`);
        continue;
      }
      // A delete goes through the copy's own project on that machine.
      const copyPin = copy.projectId === use.projectId
        ? pin
        : args.resolvePin({ ...use, projectId: copy.projectId, projectRootPath: copy.projectRoot });
      if (copyPin === "unreachable") {
        remaining += 1;
        failed.push(`${where}: this window can't reach that project. Delete it in Settings › Machines.`);
        continue;
      }
      try {
        const answer = await api.delete({ owner: copy.owner, projectId: copy.projectId, keepUnsynced: true }, copyPin);
        if (answer.keptReason) {
          remaining += 1;
          kept.push(`${where}: ${answer.keptReason}`);
        } else if (answer.deleted) {
          deleted += 1;
        }
      } catch (error) {
        remaining += 1;
        failed.push(`${where}: ${remoteWorkReadErrorText(error, use.machineName)}`);
      }
    }
    if (deleted) deletedOn.push(use.machineName);
    else if (!remaining) emptyOn.push(use.machineName);
    if (!remaining) clean.push(use.machineKey);
  }
  if (deletedOn.length) {
    showToast({ tone: "success", title: `Cleaned up ${joinNames(deletedOn)}`, message: "This chat's code there, and what it held, is gone." });
  } else if (emptyOn.length && !kept.length && !failed.length && !unreachable.length) {
    showToast({ tone: "info", title: `Nothing to clean up on ${joinNames(emptyOn)}`, message: "This chat's code there was already gone." });
  }
  if (kept.length) {
    showToast({
      tone: "warning",
      title: "Kept code with work nobody pushed",
      message: `${kept.join("\n")}\nPush that work first, or delete the copy in Settings › Machines.`,
      durationMs: READABLE_TOAST_DURATION_MS,
    });
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
    showToast({
      tone: "error",
      title: "Couldn't clean up",
      message: failed.join("\n"),
      report: false,
      durationMs: READABLE_TOAST_DURATION_MS,
    });
  }
  return clean;
}
