import { useCallback, useEffect, useState } from "react";
import type { GitHubPrListItem } from "../../shared/types";
import { getGitHubSnapshotCoalesced } from "./prReadCache";
import { selectActiveProjectRoot, useAppStore } from "../state/appStore";

/**
 * This window's own view of the repo's pull requests, for a chat whose machine
 * is asleep and can't be asked. Lives outside `components/chat` because the tab's
 * machine is exactly what it wants. Nothing to ask when the tab is bound to a
 * remote machine and the chat has no pin of its own (the tab is that computer).
 */
export function useWindowMachineGithubPrs(chatHasOwnPin: boolean): {
  pullRequests: GitHubPrListItem[] | null;
  readFailed: boolean;
  retry: () => void;
} {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const windowIsAsleepToo = useAppStore((state) => state.projectBinding?.kind === "remote") && !chatHasOwnPin;
  const [pullRequests, setPullRequests] = useState<GitHubPrListItem[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (windowIsAsleepToo) return;
    let cancelled = false;
    void getGitHubSnapshotCoalesced({}, { projectRoot, bindingKey })
      .then((snapshot) => {
        if (cancelled) return;
        setPullRequests(snapshot?.repoPullRequests ?? []);
        setReadFailed(false);
      })
      .catch((error: unknown) => {
        console.warn("[chat-pr] reading GitHub for a sleeping computer failed", error);
        if (!cancelled) setReadFailed(true);
      });
    return () => { cancelled = true; };
  }, [attempt, bindingKey, projectRoot, windowIsAsleepToo]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { pullRequests, readFailed, retry };
}
