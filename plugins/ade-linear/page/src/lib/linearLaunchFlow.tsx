/**
 * The issue→lane(+chat/CLI) launch flow, shared by every Linear placement.
 *
 * It was the top half of `LinearQuickViewPanel.tsx`. The quick view itself is
 * gone — the top-bar button and its popover were removed with the rest of the
 * chrome the page tier replaced — and the launch flow outlived it, because it
 * was never the popover's: the compiled Work-rail pane and the compiled quick
 * view both routed every 1..N launch through the same `BatchLaunchModal`, so
 * the model, the kickoff prompt, the branch and the lane target are configured
 * once wherever the reader started.
 *
 * `BrowserEntry` is the one caller left, and the hook is unchanged: the file it
 * lived in went away, not the flow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bridge } from "../bridge";
import {
  createLaneForIssue,
  getChatModels,
  launchAgentOnIssue,
  launchCliOnIssue,
} from "../host/actions";
import { openLink, toast, writeClipboard } from "../host/ui";
import type { LaneLinearIssue, NormalizedLinearIssue, PageChatModel, PageLane } from "../types";
import {
  linearBrowserIssueToLaneIssue,
  type BatchProgress,
  type BrowserIssue,
  type IssueConflict,
} from "../components/LinearIssueBrowser";
import { BatchLaunchModal, type BatchLaunchSubmit } from "../components/BatchLaunchModal";
import { BatchLaunchStatusToast } from "../components/BatchLaunchStatusToast";
import {
  defaultKickoffIntro,
  defaultKickoffPrompt,
  findIssueConflicts,
  isBatchLaunchInFlight,
  runBatchLaunch,
  BatchLaunchAgentReadinessTracker,
  type BatchLaunchAgentOutcome,
  type BatchLaunchIssueConfig,
  type BatchLaunchItemState,
} from "./linearBatchLaunch";
import { laneStackDeeplink, readLaunchPromptClipboardSetting } from "../components/launchPromptClipboard";

export type LinearBatchLaunchFlow = {
  /** Wire straight into `LinearIssueBrowser`'s `batchActions.onBatchLaunch`. */
  onBatchLaunch: (issues: BrowserIssue[], options: { laneOnly?: boolean }) => void;
  /** Live progress of the real run, for `batchActions.batchProgress`. */
  batchProgress: BatchProgress | null;
  /** The duplicate guard, for `batchActions.conflicts`. */
  conflicts: Map<string, IssueConflict>;
  /** The launch-configuration modal. Portals itself; render it anywhere. */
  launchModal: React.ReactElement;
  /** The per-issue progress panel. Render it inside a `relative` box in a popover. */
  statusToast: React.ReactElement;
};

/**
 * The whole issue→lane(+chat/CLI) launch flow, for either placement.
 *
 * Both the multi-select dock and the single-issue detail dock call
 * `onBatchLaunch`, which opens the launch-configuration modal for 1..N issues —
 * that is the compiled behaviour, and it is why neither placement gets to
 * invent a default model, prompt or permission mode of its own. The modal's
 * submit runs `runBatchLaunch` and the status toast reports it.
 */
export function useLinearBatchLaunch({
  projectRoot,
  lanes,
  refreshLanes,
  portalStatusToast = false,
  onSingleLaunchSuccess,
}: {
  projectRoot: string | null;
  lanes: PageLane[];
  refreshLanes: () => void;
  /** True in the tab placement, where the toast belongs to the whole viewport. */
  portalStatusToast?: boolean;
  /**
   * Called after a ONE-issue launch that fully succeeded. The compiled quick
   * view closed itself here on its way to the Lanes tab; the tab has nothing to
   * close and passes nothing.
   */
  onSingleLaunchSuccess?: () => void;
}): LinearBatchLaunchFlow {
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchIssues, setBatchIssues] = useState<LaneLinearIssue[]>([]);
  const [batchLaneOnly, setBatchLaneOnly] = useState(false);
  const [batchLaunchStates, setBatchLaunchStates] = useState<Map<string, BatchLaunchItemState>>(new Map());
  const batchAgentReadinessRef = useRef(new BatchLaunchAgentReadinessTracker());
  // Remembers each issue's chosen config so "Retry failed" reuses the same model.
  const batchConfigByIssueRef = useRef<Map<string, BatchLaunchIssueConfig>>(new Map());
  const onSingleLaunchSuccessRef = useRef(onSingleLaunchSuccess);
  onSingleLaunchSuccessRef.current = onSingleLaunchSuccess;

  // The launch dock opens one unified launch-config modal for 1..N issues. The
  // modal closes on Launch and the bounded-parallel orchestrator runs below, so
  // the user lands on the Lanes tab immediately rather than watching a progress
  // bar. Both the multi-select dock and the single-issue row route here, so
  // every issue→lane(+chat/CLI) launch shares one path.
  const onBatchLaunch = useCallback(
    (issues: Array<NormalizedLinearIssue | LaneLinearIssue>, options: { laneOnly?: boolean }) => {
      setBatchIssues(issues.map((i) => ("raw" in i ? linearBrowserIssueToLaneIssue(i) : (i as LaneLinearIssue))));
      setBatchLaunchStates(new Map());
      setBatchLaneOnly(options.laneOnly === true);
      setBatchModalOpen(true);
    },
    [],
  );

  const launchBatch = useCallback(async (entries: BatchLaunchSubmit[]) => {
    if (!entries.length) return;
    batchAgentReadinessRef.current.beginBatch();
    // The kickoff prompt, saved before the launch sends it.
    //
    // The compiled flow read `launchPromptClipboardEnabled` off the app store —
    // an ADE preference a guest cannot see. The toggle is the plugin's own
    // setting now, read through `config.get()`, and it defaults ON exactly as
    // the app preference did. The prompt copied is the LAST launching entry's,
    // skipping lane-only rows, which is the compiled rule unchanged.
    if (await readLaunchPromptClipboardSetting()) {
      const lastLaunchEntry = [...entries].reverse().find(({ config }) => !config.laneOnly);
      const lastPrompt = lastLaunchEntry
        ? lastLaunchEntry.config.kickoffPrompt.trim()
          || (lastLaunchEntry.config.sessionType === "cli" ? defaultKickoffIntro() : defaultKickoffPrompt())
        : "";
      if (lastPrompt) void writeClipboard(lastPrompt);
    }
    //
    // It also recorded optimistic "creating lane" placeholders through
    // `launchedLanesHighlight` so the Lanes tab could draw spinner tabs the
    // instant the launch rerouted, and announced each created chat session on
    // `chatSessionEvents`. Both are module-level buses inside the renderer's
    // own bundle: a guest shares no module graph with the Lanes tab, so
    // neither has a page counterpart and neither is faked here.
    let models: PageChatModel[] = [];
    try {
      models = await getChatModels();
    } catch {
      models = [];
    }
    // Seed per-issue status so the status toast (and Retry failed) has rows,
    // and remember each issue's config for retries.
    setBatchLaunchStates(() => {
      const next = new Map<string, BatchLaunchItemState>();
      for (const { issue, config } of entries) {
        next.set(issue.id, { issue, status: "pending", laneId: null, sessionId: null, error: null });
        batchConfigByIssueRef.current.set(issue.id, config);
      }
      return next;
    });
    const result = await runBatchLaunch(
      entries,
      {
        createLane: (args) =>
          createLaneForIssue({
            issueId: args.issueId,
            name: args.name,
            ...(args.baseRef != null ? { baseRef: args.baseRef } : {}),
          }).then((created) => {
            if (!created.ok || !created.laneId) {
              throw new Error(created.message?.trim() || "The lane could not be created.");
            }
            return { id: created.laneId };
          }),
        // Single headless launch: creates the session and runs the kickoff turn
        // server-side without a mounted chat pane. When the user picked a
        // permission mode it is forwarded; otherwise the action defaults to an
        // autonomous-runnable mode.
        launch: (args) =>
          launchAgentOnIssue({
            issueId: args.issueId,
            laneId: args.laneId,
            provider: args.provider,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
            ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
            prompt: args.prompt,
          }).then((launched) => {
            if (!launched.ok) {
              throw new Error(launched.message?.trim() || "The agent could not be launched.");
            }
            return { id: launched.sessionId ?? "" };
          }),
        // CLI-agent variant: spawns a tracked terminal pty with the issue
        // attached so the agent drives it via `ade linear`. Returns the pty
        // session id, which runBatchLaunch records like a chat session id.
        launchCli: (args) =>
          launchCliOnIssue({
            issueId: args.issueId,
            laneId: args.laneId,
            provider: args.provider,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
            ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
            prompt: args.prompt,
          }).then((launched) => {
            if (!launched.ok) {
              throw new Error(launched.message?.trim() || "The CLI agent could not be launched.");
            }
            return { sessionId: launched.sessionId ?? "" };
          }),
      },
      {
        models,
        onItem: (issueId, patch) => {
          const earlyOutcome = patch.sessionId
            ? batchAgentReadinessRef.current.registerSession(issueId, patch.sessionId)
            : null;
          setBatchLaunchStates((current) => {
            const prev = current.get(issueId);
            if (!prev) return current;
            const next = new Map(current);
            next.set(issueId, {
              ...prev,
              ...patch,
              ...(patch.status === "initializing-agent" && earlyOutcome ? earlyOutcome : {}),
            });
            return next;
          });
        },
      },
    ).finally(() => batchAgentReadinessRef.current.finishRegistration());
    refreshLanes();
    if (result.failedIssueIds.length) {
      void toast({
        level: "error",
        message: result.failedIssueIds.length === 1
          ? "1 issue failed to launch."
          : `${result.failedIssueIds.length} issues failed to launch.`,
      });
    }
    // A single successful launch closes the quick view, exactly as the compiled
    // one did on its way to the Lanes tab. A batch keeps the surface open so the
    // status toast below stays readable — closing a popover would destroy it,
    // where the compiled toast outlived the popover because the app shell owned
    // it.
    if (entries.length === 1 && result.failedIssueIds.length === 0) {
      onSingleLaunchSuccessRef.current?.();
    }

    // Then send the reader where the work now is.
    //
    // The compiled panel navigated to `#/lanes?drawer=stack` — the Lanes tab
    // with the launch stack open — and a page had no deeplink that could name a
    // tab AND a drawer, so the reroute was simply missing. `ade://lane/<id>?drawer=stack`
    // is that deeplink. The lane opened is the FIRST one created, which is the
    // stack's own first row; the drawer shows the rest.
    const firstLaneId = result.createdLaneIds[0]
      ?? [...batchLaunchStates.values()].map((state) => state.laneId).find(Boolean)
      ?? null;
    if (firstLaneId) void openLink(laneStackDeeplink(firstLaneId));
  }, [refreshLanes, batchLaunchStates]);

  const handleBatchLaunch = useCallback((entries: BatchLaunchSubmit[]) => {
    // Close the modal synchronously; the orchestrator runs detached so the
    // reader is not held on a progress view. The reroute to the lane stack
    // happens at the END of `launchBatch`, once a lane exists to name — the
    // compiled flow could route to `#/lanes?drawer=stack` before the lanes were
    // made because that URL names a TAB, and a deeplink names a lane.
    setBatchModalOpen(false);
    void launchBatch(entries).catch((err) => {
      console.error("[Linear] Batch launch failed:", err);
    });
  }, [launchBatch]);

  // Cancelling the launch modal (vs. launching) must return the user to the
  // Linear pane they came from. The page IS that pane in both placements, so it
  // is already behind the modal and nothing has to be reopened; the callback
  // stays so the modal's open/close contract is unchanged.
  const handleBatchModalOpenChange = useCallback((next: boolean) => {
    setBatchModalOpen(next);
  }, []);

  const handleRetryFailed = useCallback(() => {
    const failed = [...batchLaunchStates.values()].filter((state) => state.status === "failed");
    if (!failed.length) return;
    const entries: BatchLaunchSubmit[] = failed.map((state) => ({
      issue: state.issue,
      config: batchConfigByIssueRef.current.get(state.issue.id) ?? {
        modelId: "",
        reasoningEffort: null,
        fastMode: false,
        kickoffPrompt: "",
        branchOverride: "",
      },
    }));
    void launchBatch(entries).catch((err) => {
      console.error("[Linear] Batch retry failed:", err);
    });
  }, [batchLaunchStates, launchBatch]);

  const handleDismissBatchStatus = useCallback(() => {
    setBatchLaunchStates(new Map());
  }, []);

  /**
   * Read the kickoff turn itself.
   *
   * The compiled panel subscribed to `window.ade.agentChat.onEvent` and read
   * the turn's lifecycle out of the envelope: an `error`, a `status: failed` or
   * a `done: failed` moved the row to "Needs attention" with the runtime's own
   * message. `host.subscribe({kinds:["chat"]})` is that stream, and this is
   * where it lands — narrowed to the three states a page can draw, with the
   * host's own failure sentence and nothing else of the turn.
   *
   * The effect below is the FALLBACK and stays: it infers readiness from the
   * lane and session lists moving, which is all a host that reports no chat
   * frames can offer, and it can only ever answer "done". This one is the
   * specific answer and is the only path that can draw the error state.
   *
   * Subscribed for the whole life of the flow rather than per batch. A kickoff
   * turn can fail in the seconds after the launch call returns, and a
   * subscription torn down with the modal would miss exactly that.
   */
  useEffect(() => {
    const api = bridge();
    if (!api?.host) return;
    let stopped = false;
    let unsubscribeEvent: (() => void) | null = null;
    let unsubscribeHost: (() => void) | null = null;

    const applyTransition = (transition: { issueId: string; outcome: BatchLaunchAgentOutcome }) => {
      setBatchLaunchStates((current) => {
        const state = current.get(transition.issueId);
        if (!state) return current;
        // A row the reader has already been told about stays told. The only
        // move allowed out of `done` is into the error state, because a turn
        // that failed after the session appeared is news.
        if (state.status !== "initializing-agent" && state.status !== "done") return current;
        if (state.status === "done" && transition.outcome.status === "done") return current;
        const next = new Map(current);
        next.set(transition.issueId, { ...state, ...transition.outcome });
        return next;
      });
    };

    try {
      unsubscribeEvent = api.events.on("host", (frame) => {
        if (frame.kind !== "chat") return;
        // An overflowed frame carries NO turns — more settled inside the 120 ms
        // window than it can name — so there is nothing to read and the inference
        // effect below promotes the rows out of "starting" on the same lane and
        // session traffic. A batch big enough to overflow cannot report which of
        // its kickoffs failed, and saying nothing is the honest answer: the row
        // stays as it is rather than being told a state no frame reported.
        if (frame.overflow) return;
        // Coalesced like every other frame, so one arrival can settle a whole
        // batch: fifty issues launched together settle fifty turns, last state
        // per session winning inside the window.
        for (const turn of frame.turns ?? []) {
          if (!turn?.sessionId) continue;
          const transition = batchAgentReadinessRef.current.observeChatTurn(turn);
          if (transition) applyTransition(transition);
        }
      });
    } catch {
      unsubscribeEvent = null;
    }

    void api.host
      .subscribe({ kinds: ["chat"] })
      .then((stop) => {
        if (stopped) {
          stop();
          return;
        }
        unsubscribeHost = stop;
      })
      .catch(() => {
        // A host with no chat stream. The inference effect below still promotes
        // a launched row out of "starting"; it just cannot say it failed.
      });

    return () => {
      stopped = true;
      unsubscribeEvent?.();
      unsubscribeHost?.();
    };
  }, []);

  /**
   * Promote a launched session from "starting" to "ready", by inference.
   *
   * `host.subscribe({kinds:["lane","session"]})` frames say that something
   * moved without saying what, so a host refresh is treated as "the sessions
   * this batch is waiting on now exist". That is the whole of what this can
   * know — see the chat subscription above for the turn's actual outcome.
   */
  useEffect(() => {
    const pendingSessionIds = [...batchLaunchStates.values()]
      .filter((state) => state.status === "initializing-agent" && state.sessionId)
      .map((state) => state.sessionId as string);
    if (!pendingSessionIds.length) return;
    const transitions = batchAgentReadinessRef.current.observeSessions(pendingSessionIds);
    if (!transitions.length) return;
    setBatchLaunchStates((current) => {
      let changed = false;
      const next = new Map(current);
      for (const transition of transitions) {
        const state = next.get(transition.issueId);
        if (!state || (state.status !== "initializing-agent" && state.status !== "done")) continue;
        if (state.status === "done" && transition.outcome.status === "done") continue;
        next.set(transition.issueId, { ...state, ...transition.outcome });
        changed = true;
      }
      return changed ? next : current;
    });
  }, [lanes, batchLaunchStates]);

  // Pre-launch duplicate guard: passed to the browser so the multi-select dock
  // and single-issue rows can show a "Has lane"/"Has agent" badge and confirm a
  // re-attach. We don't know the issues being browsed here, so compute against
  // the issues currently attached to lanes and to the sessions inside them (the
  // browser narrows per row).
  const conflicts = useMemo(() => {
    const attached: LaneLinearIssue[] = [];
    const seen = new Set<string>();
    const remember = (id: string | null | undefined, identifier: string | null | undefined) => {
      const issueId = id?.trim() || identifier?.trim() || "";
      if (!issueId || seen.has(issueId)) return;
      seen.add(issueId);
      attached.push({ id: issueId, identifier: identifier?.trim() ?? "" } as LaneLinearIssue);
    };
    for (const lane of lanes) {
      remember(lane.linearIssueId, lane.linearIssueKey);
      for (const link of lane.linearIssueLinks ?? []) {
        remember(link.issueId, link.issueKey);
      }
    }
    return findIssueConflicts(attached, lanes);
  }, [lanes]);

  // Live progress for the browser's dock indicator, derived from the per-issue
  // launch states of the in-flight batch.
  const batchProgress = useMemo<BatchProgress | null>(() => {
    if (batchLaunchStates.size === 0) return null;
    const states = [...batchLaunchStates.values()];
    const completed = states.filter((s) => s.status === "done").length;
    const failed = states.filter((s) => s.status === "failed" || s.status === "agent-error").length;
    const running = states.some((s) => isBatchLaunchInFlight(s.status));
    return { total: states.length, completed, failed, running };
  }, [batchLaunchStates]);

  const launchModal = (
    <BatchLaunchModal
      open={batchModalOpen}
      projectRoot={projectRoot}
      issues={batchIssues}
      lanes={lanes}
      laneOnly={batchLaneOnly}
      onOpenChange={handleBatchModalOpenChange}
      onLaunch={handleBatchLaunch}
    />
  );

  const statusToast = (
    <BatchLaunchStatusToast
      states={batchLaunchStates}
      onRetryFailed={handleRetryFailed}
      onDismiss={handleDismissBatchStatus}
      portal={portalStatusToast}
      onOpenLane={(laneId) => {
        // `selectLane(laneId)` + `#/lanes?laneId=…&focus=single` in the
        // compiled panel; `ade://lane/<uuid>` is that same target as a
        // deeplink the host resolves (see `shared/deeplinks.ts`).
        void openLink(`ade://lane/${encodeURIComponent(laneId)}`);
      }}
    />
  );

  return { onBatchLaunch, batchProgress, conflicts, launchModal, statusToast };
}
