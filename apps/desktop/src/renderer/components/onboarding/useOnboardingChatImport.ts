import { useEffect, useRef } from "react";
import type { ExternalSessionSummary, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { planImport } from "../../../shared/externalSessionPolicy";
import { chatImportKey, clearPendingChatImport, pendingChatImportFor } from "../../onboarding/pendingChatImports";
import { showToast, updateToast } from "../app/toast/toastStore";

/** Enough to pick up where the user left off, few enough not to bury Work. */
export const MAX_IMPORTED_CHATS = 25;
/** Sessions listed per pass; the newest ones in the window are what count. */
const LIST_LIMIT = 120;

function activityAt(summary: ExternalSessionSummary): number {
  return summary.updatedAt ?? summary.createdAt ?? 0;
}

/**
 * The second half of first-run setup: the first time a project opens whose
 * "Import chats" pill the user turned on there, its recent chats (from every
 * provider ADE imports) come in as ADE chats, each in the lane its folder
 * belongs to (worktrees are lanes by then) or the main checkout's. Chats the
 * user unticked in setup's picker stay out; the cap applies to what is left.
 *
 * Runs only for a project open on this computer. Setup only queues local
 * projects, and the import reads this computer's provider history, so a
 * project tab bound to another machine is left alone.
 */
export function useOnboardingChatImport({
  projectRoot,
  projectBinding,
  lanes,
  enabled,
}: {
  projectRoot: string | null;
  projectBinding: OpenProjectBinding | null;
  lanes: LaneSummary[];
  enabled: boolean;
}): void {
  const runningRef = useRef<string | null>(null);
  const isLocal = projectBinding?.kind !== "remote";
  const primaryLaneId = lanes.find((lane) => lane.laneType === "primary")?.id ?? null;

  useEffect(() => {
    if (!enabled || !projectRoot || !isLocal || !primaryLaneId) return;
    if (runningRef.current === projectRoot) return;
    const pending = pendingChatImportFor(projectRoot);
    if (!pending) return;
    runningRef.current = projectRoot;
    void importRecentChats({
      projectRoot,
      primaryLaneId,
      sinceMs: pending.sinceMs,
      excludedKeys: new Set(pending.excludedKeys ?? []),
    }).finally(() => {
      clearPendingChatImport(projectRoot);
      runningRef.current = null;
    });
  }, [enabled, isLocal, primaryLaneId, projectRoot]);
}

async function importRecentChats({
  projectRoot,
  primaryLaneId,
  sinceMs,
  excludedKeys,
}: {
  projectRoot: string;
  primaryLaneId: string;
  sinceMs: number;
  /** Chats the user left out in setup's picker (`chatImportKey`). */
  excludedKeys: ReadonlySet<string>;
}): Promise<void> {
  const api = window.ade.externalSessions;
  let summaries: ExternalSessionSummary[];
  try {
    // Unpinned: this is the tab's own machine, which is this computer.
    summaries = await api.list({ scope: "project", limit: LIST_LIMIT });
  } catch {
    return;
  }
  const candidates = summaries
    .filter((summary) => (
      activityAt(summary) >= sinceMs
      && !summary.alreadyImported
      && !summary.possiblyActive
      && !excludedKeys.has(chatImportKey(summary.provider, summary.id))
    ))
    .sort((a, b) => activityAt(b) - activityAt(a))
    .slice(0, MAX_IMPORTED_CHATS);
  if (!candidates.length) return;

  const projectName = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot;
  const toastId = showToast({
    id: `onboarding-chat-import:${projectRoot}`,
    tone: "info",
    title: `Bringing in your chats for ${projectName}`,
    message: `0 of ${candidates.length}`,
    durationMs: 0,
    dismissible: false,
    busy: true,
  });

  let imported = 0;
  let failed = 0;
  for (const summary of candidates) {
    const homeLaneId = summary.home?.kind === "lane" ? summary.home.laneId : null;
    const plan = planImport(summary, { surface: "chat", targetLaneId: homeLaneId ?? primaryLaneId });
    const action = plan.primary;
    // A session that may still be open in its CLI asks before it continues; setup never asks.
    if (!action || action.target !== "chat" || action.confirmBeforeRun) continue;
    try {
      await api.import({
        provider: summary.provider,
        sessionId: summary.id,
        laneId: plan.targetLaneId ?? primaryLaneId,
        target: "chat",
        mode: action.mode,
      });
      imported += 1;
    } catch {
      failed += 1;
    }
    updateToast(toastId, { message: `${imported + failed} of ${candidates.length}` });
  }

  updateToast(toastId, {
    tone: failed && !imported ? "warning" : "success",
    title: imported
      ? `Brought in ${imported} ${imported === 1 ? "chat" : "chats"} for ${projectName}`
      : `Couldn't bring in your chats for ${projectName}`,
    message: failed
      ? "Some didn't come in. You can import them from Work."
      : "Each one is in the lane it ran in.",
    durationMs: 8_000,
    dismissible: true,
    busy: false,
  });
}
