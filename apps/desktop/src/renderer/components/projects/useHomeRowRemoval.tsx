import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowCounterClockwise, Trash } from "@phosphor-icons/react";
import type { RecentProjectSummary } from "../../../shared/types";
import { dismissToast, showToast } from "../app/toast/toastStore";
import { recentProjectLocationKey, type RecentProjectGroup } from "../app/projectTabGrouping";
import { hideFromHome, showOnHome } from "./homeHiddenProjects";
import { removeTargetForRow, type HomeProjectRow } from "./homeProjectRows";
import { requestRemoveProject } from "./removeProjectRequest";

const UNDO_WINDOW_MS = 5_000;
const FORGET_TOAST_ID = "welcome-forget-recent";
const HIDE_TOAST_ID = "welcome-hide-account-project";

/**
 * The X of a Home row.
 *
 * - An account project opens the remove window: "From this list" first (this
 *   computer's Home stops listing it, with Undo), then this computer, all my
 *   computers, and my account. The top bar owns that window.
 * - A folder that is no account project leaves this computer's recents after
 *   an Undo window, as before: the row hides at once and the forget runs when
 *   the window ends. A connected computer's folder that this computer never
 *   opened is in no recents: Home on this computer stops listing it instead.
 */
export function useHomeRowRemoval(args: {
  recentProjects: RecentProjectSummary[];
  setRecentProjects: Dispatch<SetStateAction<RecentProjectSummary[]>>;
  setRowError: (message: string | null) => void;
}): {
  /** Rows hidden by a forget that has not committed yet. */
  pendingForgetKeys: Set<string>;
  handleRemoveRow: (row: HomeProjectRow) => void;
  /** A row hidden from this list: list it again. */
  handleShowAgain: (row: HomeProjectRow) => void;
} {
  const { recentProjects, setRecentProjects, setRowError } = args;
  const [pendingForgetKeys, setPendingForgetKeys] = useState<Set<string>>(() => new Set());
  const [forgetToast, setForgetToast] = useState<{ key: string; name: string; recentKeys: string[] } | null>(null);
  const forgetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (forgetTimerRef.current != null) window.clearTimeout(forgetTimerRef.current);
  }, []);

  // Deferred-commit forget: hide the row immediately and show an undo toast.
  // Only after the window elapses does the backend forget run. Undo cancels
  // the timer and unhides the row, with no backend call.
  const commitForget = useCallback((key: string, recentKeys: string[]) => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    const saved = new Set(recentProjects.map(recentProjectLocationKey));
    void (async () => {
      let next = recentProjects;
      for (const recentKey of recentKeys) {
        if (!saved.has(recentKey) && recentKey.startsWith("remote:")) {
          // Only another computer's catalog lists it; nothing here to forget.
          hideFromHome(recentKey);
          continue;
        }
        next = await window.ade.project.forgetRecent(recentKey);
      }
      setRecentProjects(next);
    })().catch((error: unknown) => {
      // The row reappears at the end of the undo window; say why instead of
      // letting it silently come back.
      setRowError(error instanceof Error ? error.message : String(error));
    });
    setPendingForgetKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setForgetToast(null);
  }, [recentProjects, setRecentProjects, setRowError]);

  const handleForget = useCallback((group: RecentProjectGroup) => {
    const key = group.id;
    // Flush any prior pending forget so timers never stack.
    const previousKey = forgetToast?.key ?? null;
    if (previousKey && previousKey !== key) {
      commitForget(previousKey, forgetToast?.recentKeys ?? []);
    } else if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    setForgetToast({ key, name: group.displayName, recentKeys: group.recentKeys });
    setPendingForgetKeys((prev) => new Set(prev).add(key));
    forgetTimerRef.current = window.setTimeout(() => {
      forgetTimerRef.current = null;
      commitForget(key, group.recentKeys);
    }, UNDO_WINDOW_MS);
  }, [commitForget, forgetToast]);

  const handleUndoForget = useCallback(() => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    setForgetToast((current) => {
      if (current) {
        setPendingForgetKeys((prev) => {
          const next = new Set(prev);
          next.delete(current.key);
          return next;
        });
      }
      return null;
    });
  }, []);

  // The undo offer is a shared toast; this hook's own timer decides when the
  // forget commits (and clears `forgetToast`), so the toast itself is sticky.
  useEffect(() => {
    if (!forgetToast) {
      dismissToast(FORGET_TOAST_ID);
      return;
    }
    showToast({
      id: FORGET_TOAST_ID,
      tone: "neutral",
      icon: <Trash size={15} weight="fill" />,
      title: `Removed ${forgetToast.name}`,
      actions: [
        {
          label: "Undo",
          variant: "primary",
          icon: <ArrowCounterClockwise size={12} weight="bold" />,
          onClick: handleUndoForget,
        },
      ],
      dismissible: false,
      durationMs: 0,
    });
  }, [forgetToast, handleUndoForget]);
  useEffect(() => () => dismissToast(FORGET_TOAST_ID), []);

  // "From this list": the row leaves this computer's Home list at once, with Undo.
  const [hiddenToast, setHiddenToast] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!hiddenToast) {
      dismissToast(HIDE_TOAST_ID);
      return;
    }
    showToast({
      id: HIDE_TOAST_ID,
      tone: "neutral",
      icon: <Trash size={15} weight="fill" />,
      title: `Removed ${hiddenToast.name} from this list`,
      actions: [
        {
          label: "Undo",
          variant: "primary",
          icon: <ArrowCounterClockwise size={12} weight="bold" />,
          onClick: () => {
            showOnHome(hiddenToast.id);
            setHiddenToast(null);
          },
        },
      ],
      durationMs: UNDO_WINDOW_MS,
      onClose: () => setHiddenToast((current) => (current?.id === hiddenToast.id ? null : current)),
    });
  }, [hiddenToast]);
  useEffect(() => () => dismissToast(HIDE_TOAST_ID), []);

  const handleRemoveRow = useCallback((row: HomeProjectRow) => {
    if (row.kind !== "account") {
      handleForget(row.group);
      return;
    }
    requestRemoveProject({
      kind: "target",
      ...removeTargetForRow(row, () => {
        hideFromHome(row.key);
        setHiddenToast({ id: row.key, name: row.group.displayName });
      }),
    });
  }, [handleForget]);

  const handleShowAgain = useCallback((row: HomeProjectRow) => {
    showOnHome(row.key);
    setHiddenToast((current) => (current?.id === row.key ? null : current));
  }, []);

  return { pendingForgetKeys, handleRemoveRow, handleShowAgain };
}
