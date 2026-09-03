import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, Warning, X } from "@phosphor-icons/react";
import { LinearMark, LINEAR_BRAND } from "@ade-dev/ui";

import { bridge, type PluginWebviewContext } from "../bridge";
import {
  createLaneForIssue,
  deleteLane,
  getChatModels,
  getConnection,
  launchAgentOnIssue,
  launchCliOnIssue,
} from "../host/actions";
import { closeSurface, openLink, openSettings, toast, writeClipboard } from "../host/ui";
import { useHostLanes } from "../host/useHostEntities";
import type {
  CtoLinearQuickView,
  LaneLinearIssue,
  NormalizedLinearIssue,
  PageChatModel,
  PageLane,
} from "../types";
import {
  clearLinearQuickViewSelection,
  LinearIssueBrowser,
  linearBrowserIssueToLaneIssue,
  type BatchProgress,
  type BrowserIssue,
  type IssueConflict,
} from "./LinearIssueBrowser";
import { BatchLaunchModal, type BatchLaunchSubmit } from "./BatchLaunchModal";
import { BatchLaunchStatusToast } from "./BatchLaunchStatusToast";
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
} from "../lib/linearBatchLaunch";
import { laneStackDeeplink, readLaunchPromptClipboardSetting, WELCOME_DEEPLINK } from "./launchPromptClipboard";

/**
 * The Linear quick view, as the plugin's own popover — and the launch flow both
 * Linear placements share.
 *
 * This file is the PANEL half of
 * `apps/desktop/src/renderer/components/app/LinearQuickViewButton.tsx`. The
 * button half is gone: the top-bar socket button is ADE's own chrome now, the
 * manifest's `toolbar-action` answers
 * `{openWebview:{surfaceId:"quickview",placement:"popover"}}`, and this page IS
 * the popover body. Everything inside the compiled panel — the branded header,
 * the search and nav verbs and list (all of which live in
 * `LinearIssueBrowser`), the launch flow, the status toast and the
 * deeplink-driven issue focus — moved here unchanged apart from its host calls.
 *
 * `useLinearBatchLaunch` below is the launch flow lifted OUT of the panel, so
 * the full-page tab (`entries/BrowserEntry`) and the popover
 * (`entries/QuickViewEntry`) run one implementation rather than two. In the
 * compiled app both the Work-rail Linear pane and the top-bar quick view routed
 * every 1..N issue launch through the same `BatchLaunchModal`; the hook is how
 * that stays true here.
 *
 * WHAT THE COMPILED PANEL DID THAT A GUEST CANNOT:
 *
 *  - **The visibility poll.** The compiled component polled
 *    `getLinearConnectionStatus` on a timer so the header BUTTON could appear
 *    the moment Linear connected. There is no button to reveal here — the host
 *    only opens this surface when the reader presses one — so the poll timers,
 *    the `ade:runtime-bridge-ready` listener and the 2s startup delay are gone.
 *    The connection is read once on mount and again on window focus, which is
 *    what the connect prompt below still needs.
 *  - **`useBuiltinSurfaceVisible("linear")`.** The page IS the plugin surface;
 *    a plugin that is not installed does not draw one.
 *  - **The browser-view occlusion events.** A guest cannot occlude ADE's native
 *    BrowserView and nothing in this document listens for those events.
 *  - **The renderer buses** (`launchedLanesHighlight`, `chatSessionEvents`).
 *    See the launch flow below. `launchPromptClipboard` is no longer among
 *    them: it was an APP preference the compiled panel read off the store, and
 *    it is now the plugin's own `launchPromptClipboard` setting.
 */

const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg/90";

const VISIBILITY_CONNECTED_CACHE_TTL_MS = 60_000;
const VISIBILITY_DISCONNECTED_CACHE_TTL_MS = 1_500;

/** The deeplink-driven focus request, formerly `linearIssueQuickViewNavigation`. */
export type LinearIssueQuickViewRequest = {
  issueIdentifier: string;
  branch?: string | null;
  source?: "deeplink" | "manual";
  requestedAt: number;
};

type LinearVisibilityCacheEntry = {
  reader: unknown;
  value: boolean;
  checkedAtMs: number;
  inFlight: Promise<boolean> | null;
};

const linearVisibilityCacheByProject = new Map<string, LinearVisibilityCacheEntry>();

function readLinearVisibilityCached({
  projectRoot,
  reader,
  force = false,
}: {
  projectRoot: string | null | undefined;
  reader: (() => Promise<{ connected?: boolean }>) | undefined;
  force?: boolean;
}): Promise<boolean> {
  if (!projectRoot || !reader) return Promise.resolve(false);
  const now = Date.now();
  const existing = linearVisibilityCacheByProject.get(projectRoot);
  const entry =
    existing && existing.reader === reader
      ? existing
      : { reader, value: false, checkedAtMs: 0, inFlight: null };
  linearVisibilityCacheByProject.set(projectRoot, entry);

  if (entry.inFlight) return entry.inFlight;
  const ttl = entry.value ? VISIBILITY_CONNECTED_CACHE_TTL_MS : VISIBILITY_DISCONNECTED_CACHE_TTL_MS;
  if (!force && now - entry.checkedAtMs < ttl) {
    return Promise.resolve(entry.value);
  }

  entry.inFlight = reader()
    .then((status) => {
      const nextValue = status.connected === true;
      entry.value = nextValue;
      entry.checkedAtMs = Date.now();
      return nextValue;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
}

/**
 * The host's `{issueIdentifier}` pointer, normalized the way the compiled
 * request bus normalized a deeplink: identifier upper-cased and trimmed, blank
 * branch collapsed to null. This is the page's replacement for
 * `consumePendingLinearIssueQuickViewRequest` — the toolbar action carries the
 * request in the context rather than through a module-level event bus, because
 * a guest shares no module graph with whatever raised the deeplink.
 */
function quickViewRequestFromPointer(
  pointer: Record<string, unknown> | undefined,
): LinearIssueQuickViewRequest | null {
  const raw = pointer?.issueIdentifier;
  const issueIdentifier = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!issueIdentifier) return null;
  const rawBranch = pointer?.branch;
  const branch = typeof rawBranch === "string" ? rawBranch.trim() || null : null;
  return { issueIdentifier, branch, source: "deeplink", requestedAt: Date.now() };
}

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
        deleteLane: (args) => deleteLane(args.laneId).then(() => undefined),
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
        // The frame is coalesced like every other, so one arrival can settle a
        // whole batch: fifty issues launched together settle fifty turns.
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

export function LinearQuickViewPanel({ context }: { context: PluginWebviewContext }) {
  const activeProjectRoot = context.project?.root ?? null;
  const { lanes, refresh: refreshLanes } = useHostLanes();

  const [visible, setVisible] = useState(false);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const [quickViewRequest, setQuickViewRequest] = useState<LinearIssueQuickViewRequest | null>(
    () => quickViewRequestFromPointer(context.pointer),
  );
  const [connectionPrompt, setConnectionPrompt] = useState<LinearIssueQuickViewRequest | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [browserLoading, setBrowserLoading] = useState(false);
  const cachedQuickViewRef = useRef<CtoLinearQuickView | null>(null);

  const loadVisibility = useCallback(async (options?: { force?: boolean }): Promise<boolean> => {
    return readLinearVisibilityCached({
      projectRoot: activeProjectRoot,
      reader: getConnection,
      force: options?.force === true,
    });
  }, [activeProjectRoot]);

  const openLinearSettings = useCallback(() => {
    setConnectionPrompt(null);
    void openSettings({ socketId: "connection" });
  }, []);

  const handleQuickViewRequest = useCallback((request: LinearIssueQuickViewRequest) => {
    setQuickViewRequest(request);
    setConnectionPrompt(null);
    void loadVisibility()
      .then((nextVisible) => {
        setVisible(nextVisible);
        if (nextVisible) {
          setConnectionPrompt(null);
        } else {
          setConnectionPrompt(request);
        }
      })
      .catch(() => {
        setVisible(false);
        setConnectionPrompt(request);
      });
  }, [loadVisibility]);

  // The toolbar action's pointer is the only way an issue-focus request reaches
  // this page, and it is present at mount rather than broadcast later.
  const pointerRequest = useMemo(
    () => quickViewRequestFromPointer(context.pointer),
    [context.pointer],
  );
  useEffect(() => {
    if (!pointerRequest) return;
    handleQuickViewRequest(pointerRequest);
  }, [handleQuickViewRequest, pointerRequest]);

  useEffect(() => {
    setVisible(false);
    setQuickView(null);
  }, [activeProjectRoot]);

  useEffect(() => {
    let cancelled = false;
    void loadVisibility()
      .then((nextVisible) => {
        if (!cancelled) setVisible(nextVisible);
      })
      .catch(() => {
        if (!cancelled) setVisible(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadVisibility]);

  useEffect(() => {
    if (!activeProjectRoot) return;
    let cancelled = false;
    const refresh = () => {
      void loadVisibility({ force: true })
        .then((nextVisible) => {
          if (!cancelled) setVisible(nextVisible);
        })
        .catch(() => {
          if (!cancelled) setVisible(false);
        });
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [loadVisibility, activeProjectRoot]);

  /**
   * Close the quick view.
   *
   * The compiled `close()` cleared the browser's persisted selection and set
   * `open` to false on a popover the app shell owned. Here the host owns the
   * placement, so it asks the host to close it.
   */
  const close = useCallback(() => {
    clearLinearQuickViewSelection(activeProjectRoot);
    void closeSurface();
  }, [activeProjectRoot]);

  const launch = useLinearBatchLaunch({
    projectRoot: activeProjectRoot,
    lanes,
    refreshLanes,
    onSingleLaunchSuccess: close,
  });

  // Escape closes, exactly as the compiled popover did. The compiled component
  // also closed on a mousedown outside its own box; inside a guest there is no
  // "outside" — the host dismisses its own popover on an outside press.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const connectionPromptModal = connectionPrompt ? createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) setConnectionPrompt(null);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Linear deeplink unavailable"
        className="w-[min(440px,100%)] overflow-hidden rounded-xl border border-white/12 bg-[color:var(--shell-surface)] text-fg shadow-2xl shadow-black/50"
      >
        <div className="flex items-start gap-3 border-b border-white/10 px-4 py-3">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-yellow-500/12 text-yellow-200">
            <Warning size={15} weight="fill" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">
              {activeProjectRoot
                ? `Connect Linear to open ${connectionPrompt.issueIdentifier}`
                : `Open the ADE project for ${connectionPrompt.issueIdentifier}`}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted-fg/75">
              {activeProjectRoot
                ? "This link opens the Linear pane in ADE, but this project is not connected to Linear yet."
                : "This link needs the ADE project that owns the issue open before ADE can check Linear."}
            </div>
          </div>
        </div>
        <div className="grid gap-2 px-4 py-3 text-[12px]">
          <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-3">
            <span className="text-muted-fg/50">Issue</span>
            <span className="min-w-0 truncate font-mono text-muted-fg/80">{connectionPrompt.issueIdentifier}</span>
          </div>
          {connectionPrompt.branch ? (
            <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-3">
              <span className="text-muted-fg/50">Branch</span>
              <span className="min-w-0 break-all font-mono text-muted-fg/80">{connectionPrompt.branch}</span>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button
            type="button"
            className="ade-shell-control inline-flex h-8 items-center rounded-md px-3 text-[12px]"
            data-variant="ghost"
            onClick={() => setConnectionPrompt(null)}
          >
            Dismiss
          </button>
          {activeProjectRoot ? (
            <button
              type="button"
              className="ade-shell-control inline-flex h-8 items-center rounded-md px-3 text-[12px]"
              data-variant="primary"
              onClick={openLinearSettings}
            >
              Open Linear settings
            </button>
          ) : (
            /*
             * The compiled button called `setShowWelcome(true)` and rerouted to
             * `#/work`, which is ADE's project picker — two renderer calls, and
             * for a while there was no deeplink that meant either, so this
             * control dismissed the prompt and did nothing else.
             * `ade://welcome` is that deeplink. The prompt is dismissed first
             * because the reader is leaving this popover either way.
             */
            <button
              type="button"
              className="ade-shell-control inline-flex h-8 items-center rounded-md px-3 text-[12px]"
              data-variant="primary"
              onClick={() => {
                setConnectionPrompt(null);
                void openLink(WELCOME_DEEPLINK);
                void closeSurface();
              }}
            >
              Open project picker
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      {connectionPromptModal}

      {/*
        The compiled panel was a portalled, centered dialog sized
        `h-[min(940px,…)] w-[min(1760px,…)]` because it floated over the app.
        The popover placement IS that box, sized by the host, so the panel fills
        it. Every other class, and the entire header below, is the compiled
        panel's own.
      */}
      <div
        role="dialog"
        aria-label="Linear quick view"
        className="relative flex h-full w-full flex-col overflow-hidden bg-[color:var(--shell-surface)] text-fg"
      >
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3 py-2"
          style={{ background: LINEAR_BRAND.surface }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
              style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
            >
              <LinearMark size={14} />
            </span>
            <div className="min-w-0 truncate text-[12px] text-fg/90">
              <span className="font-medium">{quickView?.organization?.name ?? "Linear"}</span>
              <span className="text-muted-fg/45"> · </span>
              <span className="text-muted-fg/65">
                {quickView?.viewer?.displayName ?? quickView?.connection.viewerName ?? "Connected"}
                {quickView?.organization?.urlKey ? ` · ${quickView.organization.urlKey}` : ""}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
              data-variant="ghost"
              onClick={() => setRefreshKey((key) => key + 1)}
              disabled={browserLoading}
              title="Refresh Linear"
            >
              {browserLoading ? <CircleNotch size={11} className="animate-spin" /> : null}
              Refresh
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded-md"
              data-variant="ghost"
              onClick={close}
              title="Close Linear"
            >
              <X size={12} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <LinearIssueBrowser
            projectRoot={activeProjectRoot}
            actionLabel="Create lane"
            actionBusyLabel="Creating lane"
            refreshKey={refreshKey}
            onIssueAction={async () => undefined}
            onConnectionVisibilityChange={setVisible}
            onOpenLinearSettings={openLinearSettings}
            requestedIssueIdentifier={quickViewRequest?.issueIdentifier ?? null}
            requestedIssueRequestKey={quickViewRequest?.requestedAt ?? null}
            onQuickViewChange={(data) => {
              cachedQuickViewRef.current = data;
              setQuickView(data);
            }}
            onLoadingChange={setBrowserLoading}
            batchActions={{
              onBatchLaunch: launch.onBatchLaunch,
              conflicts: launch.conflicts,
              batchProgress: launch.batchProgress,
            }}
          />
        </div>

        {launch.statusToast}
      </div>

      {launch.launchModal}
    </>
  );
}

/**
 * The compiled `variant="menu-row"` trigger, kept as an exported class so the
 * host's own status menu can style a Linear row identically if it grows one.
 * The button itself does not live here any more — it is ADE's chrome.
 */
export { HEADER_STATUS_MENU_ROW_CLASS };
