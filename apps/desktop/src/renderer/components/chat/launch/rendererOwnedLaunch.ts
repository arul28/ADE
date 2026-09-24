import type { MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { invalidateAgentChatSessionListCache } from "../../../lib/agentChatSessionListCache";
import {
  DRAFT_LAUNCH_JOB_STALE_AFTER_MS,
  pruneDraftLaunchJobs,
  withDraftLaunchTimeout,
  type BackgroundLaunchNotice,
  type DraftLaunchJob,
  type DraftLaunchKind,
  type DraftLaunchMode,
  type DraftLaunchSnapshot,
  type PreparedDraftLaunch,
} from "../../../lib/draftLaunchJobs";
import { extractError } from "../../../lib/format";
import { invalidateSessionListCache } from "../../../lib/sessionListCache";
import type { ComposerHandoff } from "./chatLaunchDock";

export type SubmittedDraftTextEdit = {
  submittedText: string;
  kind: "append" | "replacement";
};

export function clearSubmittedDraftText(
  current: string,
  submitted: string,
  edit?: SubmittedDraftTextEdit | null,
): string {
  if (!submitted) return current;
  if (current === submitted) {
    return edit?.submittedText === submitted && edit.kind === "replacement" ? current : "";
  }
  if (
    edit?.submittedText === submitted
    && edit.kind === "append"
    && current.startsWith(submitted)
  ) return current.slice(submitted.length);
  return current;
}

export function removeSubmittedDraftItems<T>(
  current: T[],
  submitted: readonly T[],
  matches: (current: T, submitted: T) => boolean = Object.is,
): T[] {
  if (!current.length || !submitted.length) return current;
  const remaining = [...submitted];
  let changed = false;
  const next = current.filter((item) => {
    const index = remaining.findIndex((entry) => matches(item, entry));
    if (index < 0) return true;
    remaining.splice(index, 1);
    changed = true;
    return false;
  });
  return changed ? next : current;
}

export function removeSubmittedDraftItemsById<T>(
  current: readonly T[],
  currentIds: readonly string[],
  submitted: readonly T[],
  submittedIds: readonly string[],
  fallbackMatches: (current: T, submitted: T) => boolean = Object.is,
): { items: T[]; ids: string[] } {
  const remaining = submitted.map((item, index) => ({ item, id: submittedIds[index] }));
  const items: T[] = [];
  const ids: string[] = [];
  let changed = false;
  current.forEach((item, index) => {
    const id = currentIds[index];
    const matchIndex = remaining.findIndex((entry) => (
      id && entry.id ? id === entry.id : fallbackMatches(item, entry.item)
    ));
    if (matchIndex < 0) {
      items.push(item);
      ids.push(id ?? "");
      changed = changed || !id;
      return;
    }
    remaining.splice(matchIndex, 1);
    changed = true;
  });
  return changed ? { items, ids } : { items: [...current], ids: [...currentIds] };
}

export function sameStoredDraftItem(left: unknown, right: unknown): boolean {
  const withoutScreenshot = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const copy = { ...value as Record<string, unknown> };
    delete copy.screenshotDataUrl;
    return copy;
  };
  try {
    return JSON.stringify(withoutScreenshot(left)) === JSON.stringify(withoutScreenshot(right));
  } catch {
    return false;
  }
}

type PendingRendererLaunchHandoff = {
  handoff: ComposerHandoff;
  capturedAtMs: number;
  expiryTimer: number;
};

const pendingRendererLaunchHandoffs = new Map<string, PendingRendererLaunchHandoff>();

function removePendingRendererLaunchHandoff(jobId: string): void {
  const entry = pendingRendererLaunchHandoffs.get(jobId);
  if (!entry) return;
  window.clearTimeout(entry.expiryTimer);
  pendingRendererLaunchHandoffs.delete(jobId);
}

function sweepRendererLaunchHandoffs(nowMs = Date.now()): void {
  for (const [jobId, entry] of pendingRendererLaunchHandoffs) {
    if (nowMs - entry.capturedAtMs > DRAFT_LAUNCH_JOB_STALE_AFTER_MS) {
      removePendingRendererLaunchHandoff(jobId);
    }
  }
}

/** Keep the visual origin available if the foreground launch's pane remounts before IPC settles. */
export function stashRendererLaunchHandoff(jobId: string, handoff: ComposerHandoff | null): void {
  if (!handoff) {
    discardRendererLaunchHandoff(jobId);
    return;
  }
  sweepRendererLaunchHandoffs();
  removePendingRendererLaunchHandoff(jobId);
  const entry: PendingRendererLaunchHandoff = {
    handoff,
    capturedAtMs: Date.now(),
    expiryTimer: 0,
  };
  entry.expiryTimer = window.setTimeout(() => {
    if (pendingRendererLaunchHandoffs.get(jobId) === entry) {
      pendingRendererLaunchHandoffs.delete(jobId);
    }
  }, DRAFT_LAUNCH_JOB_STALE_AFTER_MS);
  pendingRendererLaunchHandoffs.set(jobId, entry);
}

/** Consume a captured origin when a remounted pane resumes a ready launch. */
export function takeRendererLaunchHandoff(jobId: string): ComposerHandoff | null {
  sweepRendererLaunchHandoffs();
  const handoff = pendingRendererLaunchHandoffs.get(jobId)?.handoff ?? null;
  removePendingRendererLaunchHandoff(jobId);
  return handoff;
}

export function discardRendererLaunchHandoff(jobId: string | null | undefined): void {
  if (jobId) removePendingRendererLaunchHandoff(jobId);
}

/**
 * The renderer-owned launch chain: resolve (or create) the lane, start the
 * chat or CLI session in it, and track it as a draft launch job. Used for
 * launches into an existing lane, and as the fallback for a new-lane launch
 * on a runtime that predates `chat.startLaunch`.
 *
 * Extracted from `AgentChatPane` with every pane dependency passed in, so the
 * pane keeps owning its state and this stays one readable sequence.
 */

export type DraftLaunchLaneTarget = {
  laneId: string;
  laneName: string;
  worktreePath: string | null;
  autoCreated: boolean;
};

export type StartedDraftLaunch = {
  sessionId: string;
  draftKind: DraftLaunchKind;
};

export type OpenLaunchedDraftSessionInput = BackgroundLaunchNotice & {
  jobId?: string;
  firstMessage?: PreparedDraftLaunch;
  composerHandoff?: ComposerHandoff | null;
};

export type RendererOwnedLaunchDeps = {
  kind: DraftLaunchKind;
  mode: DraftLaunchMode;
  snapshot: DraftLaunchSnapshot;
  /** The project this launch is pinned to (see below). */
  launchBinding: OpenProjectBinding;
  /** Double-press guard key; released when the chain settles. */
  requestKey: string;
  /** The draft targets "Auto-create lane". */
  autoCreate: boolean;
  /** The pane's lane, to refresh its session list when the chat lands there. */
  paneLaneId: string | null;
  jobId: string;
  jobTitle: string;
  latestForegroundJobIdRef: MutableRefObject<string | null>;
  inFlightKeysRef: MutableRefObject<Set<string>>;
  paneMountedRef: MutableRefObject<boolean>;
  captureHandoffOrigin: () => ComposerHandoff | null;
  prepare: (snapshot: DraftLaunchSnapshot) => PreparedDraftLaunch;
  resolveLane: (
    snapshot: DraftLaunchSnapshot,
    options: {
      onAutoCreateNameResolved: () => void;
      onAutoCreateNameModelResolved: (modelId: string) => void;
      assertActive: () => void;
      pin: OpenProjectBinding;
    },
  ) => Promise<DraftLaunchLaneTarget>;
  startChat: (
    prepared: PreparedDraftLaunch,
    targetLane: DraftLaunchLaneTarget,
    pin: OpenProjectBinding,
    assertActive: () => void,
  ) => Promise<StartedDraftLaunch>;
  startCli: (
    prepared: PreparedDraftLaunch,
    targetLane: DraftLaunchLaneTarget,
    mode: DraftLaunchMode,
    assertActive: () => void,
    pin: OpenProjectBinding,
  ) => Promise<StartedDraftLaunch>;
  clearPromptSuggestion: () => void;
  setError: (message: string | null) => void;
  setDraftLaunchJobs: (next: (prev: DraftLaunchJob[]) => DraftLaunchJob[]) => void;
  clearDraftLaunchComposer: (snapshot: DraftLaunchSnapshot) => void;
  patchDraftLaunchJob: (jobId: string, patch: Partial<DraftLaunchJob>) => void;
  draftLaunchJobExists: (jobId: string) => boolean;
  canRefreshPinnedProject: (pin?: OpenProjectBinding | null) => boolean;
  refreshSessions: (options?: { force?: boolean }) => Promise<unknown>;
  refreshLanes: () => Promise<unknown>;
  openLaunchedDraftSession: (launch: OpenLaunchedDraftSessionInput) => void;
  clearSelectedSession: () => void;
};

export async function runRendererOwnedLaunch(deps: RendererOwnedLaunchDeps): Promise<void> {
  const { kind, mode, snapshot, launchBinding, jobId } = deps;
  // Pin this launch to the project that started it. The chain runs detached
  // from the pane's lifecycle, so if the user switches projects mid-launch the
  // lane/session/send calls keep targeting the originating runtime instead of
  // the now-active project. `launchBinding` is the pane's project-scoped
  // binding; the root store's binding tracks whichever project is currently
  // active.
  //
  // `launchTimedOut` is the normal abort source: withDraftLaunchTimeout rejects
  // the renderer wait but cannot cancel the underlying IPC, so a timed-out
  // step that keeps running must be stopped before its next mutation.
  let launchTimedOut = false;
  const assertLaunchActive = () => {
    if (launchTimedOut) {
      throw new Error("Draft launch aborted after timeout.");
    }
  };
  const markLaunchTimedOut = () => {
    launchTimedOut = true;
  };

  if (mode === "foreground") {
    deps.latestForegroundJobIdRef.current = jobId;
  }
  const job: DraftLaunchJob = {
    id: jobId,
    mode,
    draftKind: kind,
    target: "local",
    // Auto-create no longer blocks on naming (deterministic name now, AI rename
    // in the background), so the launch goes straight to lane creation.
    status: deps.autoCreate ? "creating-lane" : "starting-session",
    title: deps.jobTitle,
    laneId: null,
    laneName: null,
    sessionId: null,
    namingModelId: null,
    error: null,
    warning: null,
    autoOpen: mode === "foreground",
    createdAtMs: Date.now(),
    snapshot,
  };
  deps.clearPromptSuggestion();
  deps.setError(null);
  deps.setDraftLaunchJobs((current) => pruneDraftLaunchJobs([
    job,
    ...current.map((entry) => (
      mode === "foreground" && entry.mode === "foreground"
        ? { ...entry, autoOpen: false }
        : entry
    )),
  ]));
  // A foreground chat keeps its prompt in the composer until the chat opens,
  // so the text never vanishes into an empty wait; the opening chat then flies
  // it up into the first bubble. Everything else clears at once as before.
  const holdsComposerUntilOpen = kind === "chat" && mode === "foreground";
  let composerHandoff: ComposerHandoff | null = null;
  if (!holdsComposerUntilOpen) deps.clearDraftLaunchComposer(snapshot);

  let targetLane: DraftLaunchLaneTarget | null = null;

  try {
    if (holdsComposerUntilOpen) {
      composerHandoff = deps.captureHandoffOrigin();
      stashRendererLaunchHandoff(jobId, composerHandoff);
    }
    const prepared = deps.prepare(snapshot);
    targetLane = await withDraftLaunchTimeout(deps.resolveLane(snapshot, {
      onAutoCreateNameResolved: () => {
        deps.patchDraftLaunchJob(jobId, { status: "creating-lane" });
      },
      onAutoCreateNameModelResolved: (namingModelId) => {
        deps.patchDraftLaunchJob(jobId, { namingModelId });
      },
      assertActive: assertLaunchActive,
      pin: launchBinding,
    }), "Lane setup", markLaunchTimedOut);
    deps.patchDraftLaunchJob(jobId, {
      status: "starting-session",
      laneId: targetLane.laneId,
      laneName: targetLane.laneName,
    });
    deps.patchDraftLaunchJob(jobId, {
      status: "sending-prompt",
      laneId: targetLane.laneId,
      laneName: targetLane.laneName,
    });
    // Re-check before starting the session. The start functions also re-assert
    // immediately before each of their own mutating calls.
    assertLaunchActive();
    const launched = await withDraftLaunchTimeout(
      kind === "chat"
        ? deps.startChat(prepared, targetLane, launchBinding, assertLaunchActive)
        : deps.startCli(prepared, targetLane, mode, assertLaunchActive, launchBinding),
      "Session start",
      markLaunchTimedOut,
    );
    invalidateSessionListCache();
    invalidateAgentChatSessionListCache({ laneId: targetLane.laneId });
    if (launched.draftKind === "chat" && targetLane.laneId === deps.paneLaneId && deps.canRefreshPinnedProject(launchBinding)) {
      void deps.refreshSessions({ force: true }).catch(() => {});
    }
    const launch = {
      laneId: targetLane.laneId,
      laneName: targetLane.laneName,
      sessionId: launched.sessionId,
      draftKind: launched.draftKind,
    };
    const canMutateLaunchUi = deps.canRefreshPinnedProject(launchBinding);
    const shouldAutoOpen =
      canMutateLaunchUi && mode === "foreground" && deps.latestForegroundJobIdRef.current === jobId;
    const jobStillVisible = deps.draftLaunchJobExists(jobId);
    deps.patchDraftLaunchJob(jobId, {
      status: "ready",
      laneId: launch.laneId,
      laneName: launch.laneName,
      sessionId: launch.sessionId,
      draftKind: launch.draftKind,
      // Keep autoOpen set for foreground sends so the pane's effect can open the
      // chat even if the pane instance remounted during the launch (otherwise
      // the inline open is skipped and the job sits at "ready").
      autoOpen: mode === "foreground" && canMutateLaunchUi,
    });
    if (!jobStillVisible) {
      if (holdsComposerUntilOpen) deps.clearDraftLaunchComposer(snapshot);
      discardRendererLaunchHandoff(jobId);
      return;
    }
    if (holdsComposerUntilOpen) {
      // Open first: the captured origin and sent prompt land together in the new pane.
      if (shouldAutoOpen && deps.paneMountedRef.current) {
        deps.openLaunchedDraftSession({ ...launch, jobId, firstMessage: prepared, composerHandoff });
      } else if (!(shouldAutoOpen && !deps.paneMountedRef.current)) {
        discardRendererLaunchHandoff(jobId);
      }
      deps.clearDraftLaunchComposer(snapshot);
    } else if (shouldAutoOpen && deps.paneMountedRef.current) {
      deps.openLaunchedDraftSession({ ...launch, jobId });
    } else if (canMutateLaunchUi && mode === "background" && deps.paneMountedRef.current) {
      deps.clearSelectedSession();
    }
  } catch (launchError) {
    discardRendererLaunchHandoff(jobId);
    if (targetLane?.autoCreated) {
      // Pin the rollback to the originating project so it deletes the lane we
      // created, even if the active project has since changed.
      await window.ade.lanes.delete({ laneId: targetLane.laneId, force: true }, launchBinding).catch((cleanupError: unknown) => {
        console.warn(`draft ${kind} launch lane cleanup failed`, cleanupError);
      });
      if (deps.canRefreshPinnedProject(launchBinding)) {
        await deps.refreshLanes().catch(() => undefined);
      }
    }
    const message = extractError(launchError);
    const jobStillVisible = deps.draftLaunchJobExists(jobId);
    deps.patchDraftLaunchJob(jobId, {
      status: "failed",
      laneId: targetLane?.laneId ?? null,
      laneName: targetLane?.laneName ?? null,
      error: message,
      autoOpen: false,
    });
    if (jobStillVisible && deps.paneMountedRef.current) {
      deps.setError(message);
    }
  } finally {
    deps.inFlightKeysRef.current.delete(deps.requestKey);
  }
}
