import { useEffect, useRef, useState } from "react";
import { extractError } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { adeCloudProjectOf } from "../../state/adeCloudTabs";
import { accountProjectListEpoch, noteAccountProjectChange } from "../../state/accountProjectListClient";
import { showToast } from "../app/toast/toastStore";
import type { AccountProjectChangeResult, AccountProjectView } from "../../../shared/accountProject";

/** A project just added to the account: the list learns it, and its tab opens on ADE Cloud (no computer has it yet). */
export function openAddedAccountProject(project: AccountProjectView): void {
  noteAccountProjectChange({ added: project });
  void useAppStore.getState().openAdeCloudProject(adeCloudProjectOf(project)).catch(() => undefined);
}

type AccountAddAnswer = AccountProjectChangeResult;

/**
 * One account add, and whether another account signed in while it ran: a
 * result for the first account never lands in the next one's list.
 */
export async function addRepoToAccount(repoUrl: string): Promise<{ answer: AccountAddAnswer; accountChanged: boolean }> {
  const accountAdd = window.ade?.project?.accountAdd;
  if (typeof accountAdd !== "function") {
    return { answer: { ok: false, code: "unavailable", message: "This ADE can't add projects to your account." }, accountChanged: false };
  }
  const accountUser = () => window.ade?.account?.status?.().then((status) => status?.userId ?? null, () => null) ?? Promise.resolve(null);
  const epoch = accountProjectListEpoch();
  const startedFor = await accountUser();
  const answer: AccountAddAnswer = await accountAdd(repoUrl).catch((error: unknown) => ({
    ok: false as const,
    code: "unavailable",
    message: extractError(error),
  }));
  if (!answer.ok) return { answer, accountChanged: false };
  const endedFor = await accountUser();
  const knowsAccount = typeof window.ade?.account?.status === "function";
  const accountChanged = accountProjectListEpoch() !== epoch || (knowsAccount && (!startedFor || startedFor !== endedFor));
  return { answer, accountChanged };
}

/**
 * Adds a repository to the account's project list (S13), for the Add project
 * form. With `openTab` it is the whole add: the project is on the account with
 * no copy, and opens as a tab that says no computer has it. Without it, the
 * add runs beside the clones, and a signed-out client or an address only the
 * cloning computer can read is not an error.
 */
export function useAddToAccount(args: { folderName: string; onClose: () => void }) {
  const { folderName, onClose } = args;
  const [accountError, setAccountError] = useState<string | null>(null);
  const [addingToAccount, setAddingToAccount] = useState(false);
  // ADE Web adds with the browser's own account token (no computer needed).
  const canAddToAccount = typeof window.ade?.project?.accountAdd === "function";
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addToAccount = async (repoUrl: string, options: { openTab: boolean }): Promise<boolean> => {
    if (typeof window.ade?.project?.accountAdd !== "function") return false;
    setAccountError(null);
    setAddingToAccount(true);
    const { answer, accountChanged } = await addRepoToAccount(repoUrl);
    if (mountedRef.current) setAddingToAccount(false);
    if (!answer.ok) {
      // Signed out, or an ssh alias only the cloning machine can read: the
      // copies still clone, as they did before the account kept projects.
      if (!options.openTab && (answer.code === "signed_out" || answer.code === "invalid_repository")) return false;
      if (mountedRef.current) setAccountError(answer.message);
      else showToast({ tone: "error", title: `Couldn't add ${folderName} to your account`, message: answer.message });
      return false;
    }
    if (accountChanged) {
      if (mountedRef.current) onClose();
      return false;
    }
    // A form closed while the add ran opens no tab: the project only joins the list.
    if (!options.openTab || !mountedRef.current) {
      noteAccountProjectChange({ added: answer.project });
      if (options.openTab) showToast({ tone: "success", title: `Added ${answer.project.name}`, message: "Open it from Home to send its first chat." });
    } else {
      openAddedAccountProject(answer.project);
      showToast({ tone: "success", title: `Added ${answer.project.name}`, message: "Send a chat from its page to start work on ADE Cloud." });
      onClose();
    }
    return true;
  };

  return { accountError, addingToAccount, canAddToAccount, addToAccount };
}
