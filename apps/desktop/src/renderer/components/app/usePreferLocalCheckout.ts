import { useEffect, useRef } from "react";
import type { RecentProjectSummary, RemoteOpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { localCheckoutForRemote } from "./projectTabGrouping";

/**
 * The remote binding a person picked on purpose (the Chats machine picker),
 * which the local preference leaves alone until the window is back on a local
 * checkout. One per renderer, like the window it belongs to.
 */
let explicitRemotePickKey: string | null = null;

/** Marks a remote binding as chosen on purpose, before switching to it. */
export function rememberExplicitRemotePick(bindingKey: string): void {
  explicitRemotePickKey = bindingKey;
}

/**
 * A project tab runs on this computer's checkout whenever this computer has the
 * repo. When the window is bound to another machine's copy of a repo that is
 * also here, the tab moves back here in place: same position, no second tab.
 * Other machines' lanes and chats stay reachable from Lanes and Work, which
 * list every machine.
 *
 * The remote tab is replaced only once the local switch has landed. A switch
 * that fails puts the remote project back, so the window never ends on an
 * error it did not ask for.
 */
export function usePreferLocalCheckout(args: {
  /** False while something else owns the window's binding (web, restore, Chats, a transition, a new tab). */
  enabled: boolean;
  remoteBinding: RemoteOpenProjectBinding | null;
  remoteOrigin: string | null;
  openLocalTabs: readonly RecentProjectSummary[];
  knownLocalTabs: readonly RecentProjectSummary[];
  setOpenRemoteProjectTabs: (
    update: (prev: RemoteOpenProjectBinding[]) => RemoteOpenProjectBinding[],
  ) => void;
  setTabOrder: (update: (prev: string[]) => string[]) => void;
}): void {
  const { enabled, remoteBinding, remoteOrigin, openLocalTabs, knownLocalTabs, setOpenRemoteProjectTabs, setTabOrder } = args;
  // One attempt per remote binding while it stays bound, so a checkout that
  // fails to open cannot loop. Back on a local checkout, every remote binding
  // gets the preference again.
  const attemptedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (remoteBinding) return;
    attemptedKeyRef.current = null;
    explicitRemotePickKey = null;
  }, [remoteBinding]);

  useEffect(() => {
    if (!enabled || !remoteBinding) return;
    const remoteKey = remoteBinding.key;
    if (attemptedKeyRef.current === remoteKey || explicitRemotePickKey === remoteKey) return;
    const rootPath = localCheckoutForRemote({ remoteOrigin, openLocalTabs, knownLocalTabs });
    if (!rootPath) return;
    attemptedKeyRef.current = remoteKey;
    const store = useAppStore.getState();
    // Lane worktrees are never a candidate, so the worktree prompt has nothing to ask.
    void store.switchProjectToPath(rootPath, { skipWorktreeGate: true })
      .then(() => {
        const landed = useAppStore.getState();
        if (landed.projectBinding?.kind !== "local" || landed.project?.rootPath !== rootPath) return;
        setOpenRemoteProjectTabs((prev) => prev.filter((entry) => entry.key !== remoteKey));
        setTabOrder((prev) => {
          if (!prev.includes(remoteKey)) return prev;
          const without = prev.filter((key) => key !== rootPath);
          return without.map((key) => (key === remoteKey ? rootPath : key));
        });
      })
      .catch(() => {
        void useAppStore.getState()
          .switchRemoteProject(remoteBinding.targetId, remoteBinding.projectId)
          .catch(() => {});
      });
  }, [enabled, knownLocalTabs, openLocalTabs, remoteBinding, remoteOrigin, setOpenRemoteProjectTabs, setTabOrder]);
}
