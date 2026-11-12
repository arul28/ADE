import { useEffect, useRef, useState } from "react";
import { extractError } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { noteAccountProjectChange } from "../../state/accountProjectListClient";
import { showToast } from "../app/toast/toastStore";

/**
 * Adds a repository to the account's project list (S13), for the Add project
 * form. With `openTab` it is the whole add: the project is on the account with
 * no copy, and opens as a tab that says no computer has it. Without it, the
 * add runs beside the clones, and a signed-out client or an address only the
 * cloning computer can read is not an error.
 */
export function useAddToAccount(args: { webMode: boolean; folderName: string; onClose: () => void }) {
  const { webMode, folderName, onClose } = args;
  const [accountError, setAccountError] = useState<string | null>(null);
  const [addingToAccount, setAddingToAccount] = useState(false);
  const canAddToAccount = !webMode && typeof window.ade?.project?.accountAdd === "function";
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addToAccount = async (repoUrl: string, options: { openTab: boolean }): Promise<boolean> => {
    const accountAdd = window.ade?.project?.accountAdd;
    if (typeof accountAdd !== "function") return false;
    setAccountError(null);
    setAddingToAccount(true);
    const answer = await accountAdd(repoUrl).catch((error: unknown) => ({
      ok: false as const,
      code: "unavailable",
      message: extractError(error),
    }));
    if (mountedRef.current) setAddingToAccount(false);
    if (!answer.ok) {
      // Signed out, or an ssh alias only the cloning machine can read: the
      // copies still clone, as they did before the account kept projects.
      if (!options.openTab && (answer.code === "signed_out" || answer.code === "invalid_repository")) return false;
      if (mountedRef.current) setAccountError(answer.message);
      else showToast({ tone: "error", title: `Couldn't add ${folderName} to your account`, message: answer.message });
      return false;
    }
    noteAccountProjectChange({ added: answer.project });
    if (options.openTab) {
      useAppStore.getState().showNoMachineTab({ id: answer.project.id, displayName: answer.project.name, iconDataUrl: null });
      showToast({ tone: "success", title: `Added ${answer.project.name} to your account`, message: "No computer has a copy yet." });
      onClose();
    }
    return true;
  };

  return { accountError, addingToAccount, canAddToAccount, addToAccount };
}
