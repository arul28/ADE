import { useEffect, useRef } from "react";
import type { RecentProjectSummary, RemoteOpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { localCheckoutForRemote } from "./projectTabGrouping";

/**
 * The remote bindings a person picked on purpose (the Home machine menu),
 * which the local preference leaves alone for as long as their tab stays open.
 * Kept in localStorage: the window restores its remote tabs after a reload or
 * a restart, and a pick held only in memory would be forgotten by then, so
 * the restored tab moved back to this computer and closed.
 */
const EXPLICIT_PICKS_STORAGE_KEY = "ade.projectTabs.explicitRemotePicks";
const MAX_EXPLICIT_PICKS = 50;

function readExplicitPicks(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(EXPLICIT_PICKS_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExplicitPicks(keys: Iterable<string>): void {
  try {
    window.localStorage.setItem(EXPLICIT_PICKS_STORAGE_KEY, JSON.stringify([...keys].slice(-MAX_EXPLICIT_PICKS)));
  } catch {
    // Storage full or unavailable: the pick still holds until the next reload.
  }
}

/**
 * Marks a remote binding as chosen on purpose, before switching to it.
 *
 * The store is shared by every window on this origin, so it is re-read here
 * rather than trusting a copy this renderer loaded earlier: writing this
 * window's stale view back would drop a pick another window just made.
 */
export function rememberExplicitRemotePick(bindingKey: string): void {
  const picks = readExplicitPicks();
  picks.delete(bindingKey);
  picks.add(bindingKey);
  writeExplicitPicks(picks);
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
  /** The window's open remote tabs; a pick whose tab closed is forgotten. */
  openRemoteKeys: readonly string[];
  remoteOrigin: string | null;
  openLocalTabs: readonly RecentProjectSummary[];
  knownLocalTabs: readonly RecentProjectSummary[];
  setOpenRemoteProjectTabs: (
    update: (prev: RemoteOpenProjectBinding[]) => RemoteOpenProjectBinding[],
  ) => void;
  setTabOrder: (update: (prev: string[]) => string[]) => void;
}): void {
  const { enabled, remoteBinding, openRemoteKeys, remoteOrigin, openLocalTabs, knownLocalTabs, setOpenRemoteProjectTabs, setTabOrder } = args;
  // One attempt per remote binding while it stays bound, so a checkout that
  // fails to open cannot loop. Back on a local checkout, every remote binding
  // gets the preference again.
  const attemptedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (remoteBinding) return;
    attemptedKeyRef.current = null;
  }, [remoteBinding]);

  // Only once the window's tabs are restored (`enabled`): before that the
  // list is empty and would forget every pick.
  const openRemoteKeysSignature = openRemoteKeys.join("\n");
  /**
   * The keys this window had open on the previous pass. Only those can tell
   * this window that a pick's tab was closed here: the store is shared by
   * every window on this origin, so "everything I do not have open" includes
   * every other window's picks, and pruning those made their restored remote
   * tabs move back to this computer.
   */
  const previousOpenKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const open = new Set(openRemoteKeysSignature ? openRemoteKeysSignature.split("\n") : []);
    const previous = previousOpenKeysRef.current;
    previousOpenKeysRef.current = open;
    if (!previous) return;
    const closed = [...previous].filter((key) => !open.has(key));
    if (closed.length === 0) return;
    // Re-read before writing: another window may have picked since this one
    // loaded, and its pick has to survive this write.
    const picks = readExplicitPicks();
    let changed = false;
    for (const key of closed) {
      if (picks.delete(key)) changed = true;
    }
    if (changed) writeExplicitPicks(picks);
  }, [enabled, openRemoteKeysSignature]);

  useEffect(() => {
    if (!enabled || !remoteBinding) return;
    const remoteKey = remoteBinding.key;
    // The store, not a module-level copy: another window's pick counts here too.
    if (attemptedKeyRef.current === remoteKey || readExplicitPicks().has(remoteKey)) return;
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
