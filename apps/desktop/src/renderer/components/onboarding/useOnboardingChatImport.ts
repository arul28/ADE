import { useEffect, useRef } from "react";
import type { ExternalSessionSummary, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { planImport } from "../../../shared/externalSessionPolicy";
import { basenameCrossPlatform } from "../../../shared/pathDisplay";
import { arePathsEqual } from "../../lib/pathUtils";
import { chatImportKey, clearPendingChatImport, pendingChatImportFor } from "../../onboarding/pendingChatImports";
import { READABLE_TOAST_DURATION_MS, showToast, updateToast } from "../app/toast/toastStore";

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
 * project tab bound to another machine is left alone. Every call of one run
 * is pinned to that project's binding, so switching tabs while it runs never
 * sends one project's chats (or lane ids) to another. The queued entry is
 * cleared once the project's chats were listed, whatever the imports then
 * do (a chat that fails stays importable from Work); a list that fails
 * leaves it queued for the project's next open.
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
  // Projects with a run in flight: a tab switch away and back mid-import must not start a second one.
  const runningRef = useRef<Set<string>>(new Set());
  const bindingRef = useRef(projectBinding);
  bindingRef.current = projectBinding;
  const isLocal = projectBinding?.kind !== "remote";
  const bindingKey = projectBinding?.key ?? null;
  const primaryLaneId = lanes.find((lane) => lane.laneType === "primary")?.id ?? null;

  useEffect(() => {
    if (!enabled || !projectRoot || !isLocal || !primaryLaneId) return;
    const binding = bindingRef.current;
    // Mid-switch, the binding can still be the last tab's: wait for this project's.
    if (binding && !arePathsEqual(binding.rootPath, projectRoot)) return;
    const running = runningRef.current;
    if (running.has(projectRoot)) return;
    const pending = pendingChatImportFor(projectRoot);
    if (!pending) return;
    running.add(projectRoot);
    // This project's own binding (a local one, read in the same render as
    // `projectRoot`), so each call reaches this project whatever tab is in
    // front by the time it is sent. A tab without a binding keeps the
    // unpinned route.
    const pin = binding?.kind === "local" ? binding : null;
    void importRecentChats({
      projectRoot,
      pin,
      primaryLaneId,
      sinceMs: pending.sinceMs,
      excludedKeys: new Set(pending.excludedKeys ?? []),
    }).then((listed) => {
      if (listed) clearPendingChatImport(projectRoot);
    }).finally(() => {
      running.delete(projectRoot);
    });
  }, [bindingKey, enabled, isLocal, primaryLaneId, projectRoot]);
}

/** Imports the project's recent chats; false when its chats could not be listed (nothing was imported). */
async function importRecentChats({
  projectRoot,
  pin,
  primaryLaneId,
  sinceMs,
  excludedKeys,
}: {
  projectRoot: string;
  pin: OpenProjectBinding | null;
  primaryLaneId: string;
  sinceMs: number;
  /** Chats the user left out in setup's picker (`chatImportKey`). */
  excludedKeys: ReadonlySet<string>;
}): Promise<boolean> {
  const api = window.ade.externalSessions;
  let summaries: ExternalSessionSummary[];
  try {
    summaries = await api.list({ scope: "project", limit: LIST_LIMIT }, pin);
  } catch (error) {
    // Left queued: the next open of the project tries again.
    console.warn("[onboarding] chat import: listing the project's chats failed", {
      projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
  if (!candidates.length) return true;

  const projectName = basenameCrossPlatform(projectRoot) || projectRoot;
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
      }, pin);
      imported += 1;
    } catch (error) {
      failed += 1;
      console.warn("[onboarding] chat import: one chat did not come in", {
        projectRoot,
        provider: summary.provider,
        error: error instanceof Error ? error.message : String(error),
      });
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
    durationMs: READABLE_TOAST_DURATION_MS,
    dismissible: true,
    busy: false,
  });
  return true;
}
