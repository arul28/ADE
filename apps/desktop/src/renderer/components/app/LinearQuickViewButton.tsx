import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Warning } from "@phosphor-icons/react";

import type {
  CtoLinearQuickView,
  LaneLinearIssue,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import {
  consumePendingLinearIssueQuickViewRequest,
  subscribeLinearIssueQuickViewRequests,
  type LinearIssueQuickViewRequest,
} from "../../lib/linearIssueQuickViewNavigation";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { cn } from "../ui/cn";
import { Dialog } from "../ui/dialog";
import { linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import { LinearPaneModal } from "./LinearPaneModal";
import {
  clearLinearQuickViewSelection,
  LinearIssueBrowser,
  linearBrowserIssueToLaneIssue,
  type BatchProgress,
} from "./LinearIssueBrowser";
import { BatchLaunchModal, type BatchLaunchMachine, type BatchLaunchSubmit } from "./BatchLaunchModal";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { BatchLaunchStatusToast } from "./BatchLaunchStatusToast";
import {
  defaultKickoffIntro,
  defaultKickoffPrompt,
  findIssueConflicts,
  isBatchLaunchInFlight,
  runBatchLaunch,
  BatchLaunchAgentReadinessTracker,
  type BatchLaunchIssueConfig,
  type BatchLaunchItemState,
} from "../../lib/linearBatchLaunch";
import {
  clearCreatingIssue,
  rememberCreatingIssues,
  rememberLaunchedLanes,
} from "../../lib/launchedLanesHighlight";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { ensureHarnessPresetOnBrain } from "../../lib/harnessPresetAccountSync";
import { settingsRouteFor } from "../settings/settingsManifest";

const INITIAL_VISIBILITY_CHECK_DELAY_MS = 2_000;
const VISIBILITY_RETRY_INTERVAL_MS = 3_000;
const REMOTE_VISIBILITY_RETRY_INTERVAL_MS = 15_000;
const VISIBILITY_CONNECTED_CACHE_TTL_MS = 60_000;
const VISIBILITY_DISCONNECTED_CACHE_TTL_MS = 1_500;

const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg/90";

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

export function LinearQuickViewButton({
  onOpenHarnessSettings,
  variant = "icon",
  onMenuActivate,
  showTrigger = true,
}: {
  /** Forwarded to the batch launch modal so its model picker can reach Settings. */
  onOpenHarnessSettings?: () => void;
  variant?: "icon" | "menu-row";
  onMenuActivate?: () => void;
  /**
   * False hides the header button while keeping the component mounted, so
   * issue deeplinks still open the quick view or the project prompt when no
   * project surface is on screen.
   */
  showTrigger?: boolean;
} = {}) {
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const [quickViewRequest, setQuickViewRequest] = useState<LinearIssueQuickViewRequest | null>(null);
  const [connectionPrompt, setConnectionPrompt] = useState<LinearIssueQuickViewRequest | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchIssues, setBatchIssues] = useState<LaneLinearIssue[]>([]);
  const [batchLaneOnly, setBatchLaneOnly] = useState(false);
  const [batchLaunchStates, setBatchLaunchStates] = useState<Map<string, BatchLaunchItemState>>(new Map());
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cachedQuickViewRef = useRef<CtoLinearQuickView | null>(null);
  const batchAgentReadinessRef = useRef(new BatchLaunchAgentReadinessTracker());
  // The pane's own modal hides the native browser while it is open.
  const occludesNativeBrowser = batchModalOpen && !open;
  // Remembers each issue's chosen config so "Retry failed" reuses the same model.
  const batchConfigByIssueRef = useRef<Map<string, BatchLaunchIssueConfig>>(new Map());
  // The machine each issue's batch went to, so "Retry failed" re-runs it there.
  const batchMachineByIssueRef = useRef<Map<string, BatchLaunchMachine>>(new Map());
  // Lane id → the machine it was created on, so "Open lane" selects it there.
  const batchMachineByLaneIdRef = useRef<Map<string, BatchLaunchMachine>>(new Map());
  const activeProjectRoot =
    projectBinding?.kind === "remote" ? projectBinding.rootPath : project?.rootPath;

  useEffect(() => window.ade.agentChat.onEvent((envelope) => {
    const transition = batchAgentReadinessRef.current.observe(envelope);
    if (!transition) return;
    setBatchLaunchStates((current) => {
      const state = current.get(transition.issueId);
      if (!state || (state.status !== "initializing-agent" && state.status !== "done")) return current;
      if (state.status === "done" && transition.outcome.status === "done") return current;
      const next = new Map(current);
      next.set(transition.issueId, { ...state, ...transition.outcome });
      return next;
    });
  }), []);
  // Auto-check Linear visibility for both local and remote projects. The check
  // is driven by getLinearConnectionStatus, which routes to the remote daemon
  // when bound to a remote runtime, so a remote machine's Linear connection is
  // surfaced just like a local one. Remote uses a longer retry interval
  // (visibilityRetryIntervalMs) to avoid hammering the remote daemon.
  const shouldAutoCheckVisibility = Boolean(activeProjectRoot);
  const visibilityRetryIntervalMs =
    projectBinding?.kind === "remote"
      ? REMOTE_VISIBILITY_RETRY_INTERVAL_MS
      : VISIBILITY_RETRY_INTERVAL_MS;

  const loadVisibility = useCallback(async (options?: { force?: boolean }): Promise<boolean> => {
    return readLinearVisibilityCached({
      projectRoot: activeProjectRoot,
      reader: window.ade.cto?.getLinearConnectionStatus,
      force: options?.force === true,
    });
  }, [activeProjectRoot]);

  const openLinearSettings = useCallback(() => {
    setConnectionPrompt(null);
    window.location.hash = `#${settingsRouteFor("integrations.linear")}`;
  }, []);

  const handleQuickViewRequest = useCallback((request: LinearIssueQuickViewRequest) => {
    setQuickViewRequest(request);
    setConnectionPrompt(null);
    void loadVisibility()
      .then((nextVisible) => {
        setVisible(nextVisible);
        if (nextVisible) {
          setConnectionPrompt(null);
          setOpen(true);
        } else {
          setOpen(false);
          setConnectionPrompt(request);
        }
      })
      .catch(() => {
        setVisible(false);
        setOpen(false);
        setConnectionPrompt(request);
      });
  }, [loadVisibility]);

  useEffect(() => {
    if (variant !== "icon") return;
    const pending = consumePendingLinearIssueQuickViewRequest();
    if (pending) handleQuickViewRequest(pending);
    return subscribeLinearIssueQuickViewRequests(handleQuickViewRequest);
  }, [handleQuickViewRequest, variant]);

  useEffect(() => {
    if (!occludesNativeBrowser || typeof window === "undefined") return undefined;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [occludesNativeBrowser]);

  useEffect(() => {
    setVisible(false);
    setOpen(false);
    setQuickView(null);
  }, [activeProjectRoot]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadVisibility()
      .then((nextVisible) => {
        if (!cancelled) setVisible(nextVisible);
      })
      .catch(() => {
        if (!cancelled) setVisible(false);
      });
    }, INITIAL_VISIBILITY_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadVisibility, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility) return;
    let timer: number | null = null;
    let cancelled = false;
    const onBridge = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadVisibility()
          .then((nextVisible) => {
            if (!cancelled) setVisible(nextVisible);
          })
          .catch(() => {
            if (!cancelled) setVisible(false);
          });
      }, INITIAL_VISIBILITY_CHECK_DELAY_MS);
    };
    // If bridge already fired before this effect registered, queue the same low-priority check.
    if ((window as any).__adeRuntimeBridge) {
      onBridge();
    }
    window.addEventListener("ade:runtime-bridge-ready", onBridge);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener("ade:runtime-bridge-ready", onBridge);
    };
  }, [loadVisibility, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility) return;
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
  }, [loadVisibility, activeProjectRoot, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility) return;
    if (visible) return;
    if (!activeProjectRoot) return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void loadVisibility().then((v) => {
        if (!cancelled && v) {
          setVisible(true);
          window.clearInterval(interval);
        }
      }).catch(() => {});
    }, visibilityRetryIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadVisibility, visible, activeProjectRoot, visibilityRetryIntervalMs, shouldAutoCheckVisibility]);

  const openQuickView = useCallback(() => {
    if (cachedQuickViewRef.current) {
      setQuickView(cachedQuickViewRef.current);
    }
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    clearLinearQuickViewSelection(activeProjectRoot);
    setOpen(false);
  }, [activeProjectRoot]);

  // The launch dock opens one unified launch-config modal for 1..N issues. The
  // modal closes on Launch and the bounded-parallel orchestrator runs below, so
  // the user lands on the Lanes tab immediately rather than watching a progress
  // bar. Both the multi-select dock and the single-issue row route here, so
  // every issue→lane(+chat/CLI) launch shares one path.
  const handleBatchLaunchOpen = useCallback(
    (issues: Array<NormalizedLinearIssue | LaneLinearIssue>, options: { laneOnly?: boolean }) => {
      setBatchIssues(issues.map((i) => ("raw" in i ? linearBrowserIssueToLaneIssue(i) : (i as LaneLinearIssue))));
      setBatchLaunchStates(new Map());
      setBatchLaneOnly(options.laneOnly === true);
      setOpen(false);
      setBatchModalOpen(true);
    },
    [],
  );

  const launchBatch = useCallback(async (entries: BatchLaunchSubmit[], machine: BatchLaunchMachine) => {
    if (!entries.length) return;
    // Every create, launch and rollback in this batch goes to the chosen
    // machine; no call is left to fall back to the tab's machine.
    const pin = machine.pin;
    for (const { issue } of entries) batchMachineByIssueRef.current.set(issue.id, machine);
    batchAgentReadinessRef.current.beginBatch();
    if (launchPromptClipboardEnabled) {
      const lastLaunchEntry = [...entries].reverse().find(({ config }) => !config.laneOnly);
      const lastPrompt = lastLaunchEntry
        ? lastLaunchEntry.config.kickoffPrompt.trim()
          || (lastLaunchEntry.config.sessionType === "cli" ? defaultKickoffIntro() : defaultKickoffPrompt())
        : "";
      void copyLaunchPromptToClipboard(lastPrompt);
    }
    // Record optimistic "creating lane" placeholders for issues that mint a NEW
    // lane (existing-lane targets already have a lane), keyed by issue id. The
    // Lanes tab renders these as spinner tabs immediately on reroute and clears
    // each one as its real lane materializes (below + on lane match).
    const creatingPlaceholders = entries
      .filter(({ config }) => !config.existingLaneId)
      .map(({ issue }) => ({ issueId: issue.id, name: linearIssueLaneName(issue) }));
    if (creatingPlaceholders.length) {
      rememberCreatingIssues({ issues: creatingPlaceholders });
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
        createLane: (args) => (pin ? window.ade.lanes.create(args, pin) : window.ade.lanes.create(args)),
        // Single headless launch: creates the session and runs the kickoff turn
        // server-side without a mounted chat pane. When the user picked a
        // permission mode it is forwarded; otherwise the IPC defaults to an
        // autonomous-runnable mode.
        launch: async (args) => {
          const launchArgs: Parameters<typeof window.ade.agentChat.launch>[0] = {
            laneId: args.laneId,
            provider: args.provider,
            model: args.model,
            modelId: args.modelId,
            reasoningEffort: args.reasoningEffort,
            ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
            ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
            ...(args.interactionMode !== undefined ? { interactionMode: args.interactionMode } : {}),
            ...(args.claudePermissionMode !== undefined ? { claudePermissionMode: args.claudePermissionMode } : {}),
            ...(args.codexApprovalPolicy !== undefined ? { codexApprovalPolicy: args.codexApprovalPolicy } : {}),
            ...(args.codexSandbox !== undefined ? { codexSandbox: args.codexSandbox } : {}),
            ...(args.codexConfigSource !== undefined ? { codexConfigSource: args.codexConfigSource } : {}),
            ...(args.opencodePermissionMode !== undefined ? { opencodePermissionMode: args.opencodePermissionMode } : {}),
            ...(args.droidPermissionMode !== undefined ? { droidPermissionMode: args.droidPermissionMode } : {}),
            ...(args.cursorModeId !== undefined ? { cursorModeId: args.cursorModeId } : {}),
            ...(args.cursorConfigValues !== undefined ? { cursorConfigValues: args.cursorConfigValues } : {}),
            kickoffText: args.kickoffText,
            contextAttachments: args.contextAttachments,
            ...(args.presetId ? { presetId: args.presetId } : {}),
          };
          // Same rule as every other launch: the brain resolves a preset out
          // of its own account-settings copy, so that copy has to hold it
          // before the launch is handed over.
          await ensureHarnessPresetOnBrain(args.presetId, { targetsAnotherMachine: pin?.kind === "remote" });
          const session = pin
            ? await window.ade.agentChat.launch(launchArgs, pin)
            : await window.ade.agentChat.launch(launchArgs);
          if (activeProjectRoot && !pin) {
            announceWorkChatSessionCreated(activeProjectRoot, session);
          }
          return session;
        },
        // CLI-agent variant: spawns a tracked terminal pty with the issue
        // attached so the agent drives it via `ade linear`. Returns the pty
        // session id, which runBatchLaunch records like a chat session id.
        launchCli: async (args) => {
          await ensureHarnessPresetOnBrain(args.presetId, { targetsAnotherMachine: pin?.kind === "remote" });
          const cliArgs: Parameters<typeof window.ade.agentChat.launchCli>[0] = {
            laneId: args.laneId,
            provider: args.provider,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
            ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
            kickoffPrompt: args.kickoffPrompt,
            linearIssues: args.linearIssues,
            ...(args.presetId ? { presetId: args.presetId } : {}),
          };
          return pin ? window.ade.agentChat.launchCli(cliArgs, pin) : window.ade.agentChat.launchCli(cliArgs);
        },
        deleteLane: (args) =>
          (pin ? window.ade.lanes.delete(args, pin) : window.ade.lanes.delete(args)).then(() => undefined),
      },
      {
        onItem: (issueId, patch) => {
          // As soon as an issue reports its materialized lane id, drop its
          // optimistic spinner placeholder — the real lane will render instead.
          if (patch.laneId) {
            clearCreatingIssue(issueId);
            batchMachineByLaneIdRef.current.set(patch.laneId, machine);
          }
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
    // Clear any placeholders whose issues failed before a lane materialized so a
    // failed launch never leaves a permanent spinner tab.
    for (const issueId of result.failedIssueIds) clearCreatingIssue(issueId);
    if (pin) requestCrossMachineLanesForMachine(machine.machineId);
    else await refreshLanes({ includeStatus: false }).catch(() => undefined);
    if (!pin && (result.createdLaneIds.length || result.createdSessionIds.length)) {
      rememberLaunchedLanes({
        laneIds: result.createdLaneIds,
        sessionIds: result.createdSessionIds,
      });
    }
  }, [activeProjectRoot, launchPromptClipboardEnabled, refreshLanes]);

  const handleBatchLaunch = useCallback((entries: BatchLaunchSubmit[], machine: BatchLaunchMachine) => {
    // Close + reroute synchronously; the orchestrator runs detached so the
    // Lanes tab opens immediately rather than this being a progress view.
    setBatchModalOpen(false);
    close();
    window.location.hash = "#/lanes?drawer=stack";
    void launchBatch(entries, machine).catch((err) => {
      console.error("[Linear] Batch launch failed:", err);
    });
  }, [close, launchBatch]);

  // Cancelling the launch modal (vs. launching) must return the user to the
  // Linear pane they came from — not strand them on whatever tab is behind it
  // (handleBatchLaunchOpen hid the pane to show the modal). The launch path
  // closes the modal via setBatchModalOpen(false) directly, so Radix only fires
  // this on a genuine user dismiss (Esc/overlay/Cancel); reopen the pane there.
  // The browser remounts with its persisted filters so the selection context is
  // preserved.
  const handleBatchModalOpenChange = useCallback((next: boolean) => {
    setBatchModalOpen(next);
    if (!next) setOpen(true);
  }, []);

  const handleRetryFailed = useCallback(() => {
    const failed = [...batchLaunchStates.values()].filter((state) => state.status === "failed");
    if (!failed.length) return;
    // Retries go back to the machine each issue was sent to; issues with no
    // recorded machine are not retried rather than guessed.
    const machineIds = new Set(failed.map((state) => batchMachineByIssueRef.current.get(state.issue.id)?.machineId ?? ""));
    if (machineIds.has("") || machineIds.size !== 1) return;
    const machine = batchMachineByIssueRef.current.get(failed[0]!.issue.id)!;
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
    void launchBatch(entries, machine).catch((err) => {
      console.error("[Linear] Batch retry failed:", err);
    });
  }, [batchLaunchStates, launchBatch]);

  const handleDismissBatchStatus = useCallback(() => {
    setBatchLaunchStates(new Map());
  }, []);

  const handleOpenBatchLane = useCallback((laneId: string) => {
    const machine = batchMachineByLaneIdRef.current.get(laneId);
    if (machine?.pin) {
      // A lane on another machine is selected through its machine; the bare id
      // would select a same-id lane on the tab's machine.
      window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&machineId=${encodeURIComponent(machine.machineId)}&focus=single`;
      return;
    }
    selectLane(laneId);
    window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&focus=single`;
  }, [selectLane]);

  // Pre-launch duplicate guard: passed to the browser so the multi-select dock
  // and single-issue rows can show a "Has lane"/"Has agent" badge and confirm a
  // re-attach. We don't know the issues being browsed here, so compute against
  // the issues currently attached to lanes (the browser narrows per row).
  const conflicts = useMemo(
    () => findIssueConflicts(
      lanes.flatMap((lane) => {
        const ids: LaneLinearIssue[] = [];
        if (lane.linearIssue) ids.push(lane.linearIssue);
        for (const link of lane.linearIssueLinks ?? []) {
          if (link.issue) ids.push(link.issue);
        }
        return ids;
      }),
      lanes,
    ),
    [lanes],
  );

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

  // Raised from a Linear deeplink; it sits one layer above the quick view pane.
  const connectionPromptModal = connectionPrompt ? (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) setConnectionPrompt(null);
      }}
      title="Linear deeplink unavailable"
      hideHeader
      layer="nestedDialog"
      width={440}
      bodyPadding={false}
      // As before, nothing is focused for the user; the panel holds focus.
      preventAutoFocus
      panelStyle={{
        background: "var(--ade-shell-surface, #121019)",
        borderRadius: 12,
        borderColor: "rgba(255, 255, 255, 0.12)",
      }}
    >
      <div className="flex items-start gap-3 border-b border-white/10 px-4 py-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-yellow-500/12 text-yellow-200">
          <Warning size={15} weight="fill" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">
            {project?.rootPath
              ? `Connect Linear to open ${connectionPrompt.issueIdentifier}`
              : `Open the ADE project for ${connectionPrompt.issueIdentifier}`}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-muted-fg/75">
            {project?.rootPath
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
        {project?.rootPath ? (
          <button
            type="button"
            className="ade-shell-control inline-flex h-8 items-center rounded-md px-3 text-[12px]"
            data-variant="primary"
            onClick={openLinearSettings}
          >
            Open Linear settings
          </button>
        ) : (
          <button
            type="button"
            className="ade-shell-control inline-flex h-8 items-center rounded-md px-3 text-[12px]"
            data-variant="primary"
            onClick={() => {
              setConnectionPrompt(null);
              setShowWelcome(true);
              window.location.hash = "#/work";
            }}
          >
            Open project picker
          </button>
        )}
      </div>
    </Dialog>
  ) : null;

  if (!visible) return <>{connectionPromptModal}</>;

  const handleToggle = () => {
    if (open) {
      close();
      return;
    }
    setQuickViewRequest(null);
    openQuickView();
    onMenuActivate?.();
  };

  const trigger = variant === "menu-row" ? (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      aria-label="Linear quick view"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Linear quick view"
      className={HEADER_STATUS_MENU_ROW_CLASS}
      data-state={open ? "open" : undefined}
      onClick={handleToggle}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <LinearMark size={12} />
      <span className="min-w-0 flex-1 truncate">Linear</span>
    </button>
  ) : (
    <button
      ref={buttonRef}
      type="button"
      aria-label="Linear quick view"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Linear quick view"
      className={cn(
        "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
        "transition-[background-color,color,border-color,box-shadow] duration-150",
      )}
      data-state={open ? "open" : undefined}
      onClick={handleToggle}
      style={{
        WebkitAppRegion: "no-drag",
        color: open ? LINEAR_BRAND.primaryBright : undefined,
      } as React.CSSProperties}
    >
      <LinearMark size={13} />
    </button>
  );

  return (
    <>
      {showTrigger ? trigger : null}
      {connectionPromptModal}

      <LinearPaneModal
        open={open}
        ariaLabel="Linear quick view"
        quickView={quickView}
        loading={browserLoading}
        onRefresh={() => setRefreshKey((key) => key + 1)}
        onClose={close}
      >
        <LinearIssueBrowser
          projectRoot={project?.rootPath}
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
            onBatchLaunch: handleBatchLaunchOpen,
            conflicts,
            batchProgress,
          }}
        />
      </LinearPaneModal>

      <BatchLaunchModal
        onOpenHarnessSettings={onOpenHarnessSettings}
        open={batchModalOpen}
        projectRoot={project?.rootPath}
        issues={batchIssues}
        lanes={lanes}
        laneOnly={batchLaneOnly}
        onOpenChange={handleBatchModalOpenChange}
        onLaunch={handleBatchLaunch}
      />
      <BatchLaunchStatusToast
        states={batchLaunchStates}
        onRetryFailed={handleRetryFailed}
        onDismiss={handleDismissBatchStatus}
        onOpenLane={handleOpenBatchLane}
      />
    </>
  );
}
