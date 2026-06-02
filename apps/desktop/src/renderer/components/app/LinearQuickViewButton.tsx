import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, Warning, X } from "@phosphor-icons/react";

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
import { cn } from "../ui/cn";
import { linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import {
  clearLinearQuickViewSelection,
  LinearIssueBrowser,
  linearBrowserIssueToLaneIssue,
  type BatchProgress,
} from "./LinearIssueBrowser";
import { BatchLaunchModal, type BatchLaunchSubmit } from "./BatchLaunchModal";
import { BatchLaunchStatusToast } from "./BatchLaunchStatusToast";
import {
  defaultKickoffIntro,
  defaultKickoffPrompt,
  findIssueConflicts,
  runBatchLaunch,
  type BatchLaunchIssueConfig,
  type BatchLaunchItemState,
} from "../../lib/linearBatchLaunch";
import {
  clearCreatingIssue,
  rememberCreatingIssues,
  rememberLaunchedLanes,
} from "../../lib/launchedLanesHighlight";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";

const INITIAL_VISIBILITY_CHECK_DELAY_MS = 2_000;
const VISIBILITY_RETRY_INTERVAL_MS = 3_000;
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

function openProjectPickerRoute(): void {
  window.location.hash = "#/project";
}

export function LinearQuickViewButton({
  variant = "icon",
  onMenuActivate,
}: {
  variant?: "icon" | "menu-row";
  onMenuActivate?: () => void;
} = {}) {
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);
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
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const cachedQuickViewRef = useRef<CtoLinearQuickView | null>(null);
  // Remembers each issue's chosen config so "Retry failed" reuses the same model.
  const batchConfigByIssueRef = useRef<Map<string, BatchLaunchIssueConfig>>(new Map());

  const loadVisibility = useCallback(async (options?: { force?: boolean }): Promise<boolean> => {
    return readLinearVisibilityCached({
      projectRoot: project?.rootPath,
      reader: window.ade.cto?.getLinearConnectionStatus,
      force: options?.force === true,
    });
  }, [project?.rootPath]);

  const openLinearSettings = useCallback(() => {
    setConnectionPrompt(null);
    window.location.hash = "#/settings?tab=integrations&integration=linear";
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
    if (variant !== "icon") return;
    let cancelled = false;
    setVisible(false);
    setOpen(false);
    setQuickView(null);
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
  }, [loadVisibility, project?.rootPath, variant]);

  useEffect(() => {
    if (variant !== "icon") return;
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
  }, [loadVisibility, variant]);

  useEffect(() => {
    if (variant !== "icon") return;
    if (!project?.rootPath) return;
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
  }, [loadVisibility, project?.rootPath, variant]);

  useEffect(() => {
    if (variant !== "icon") return;
    if (visible) return;
    if (!project?.rootPath) return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void loadVisibility().then((v) => {
        if (!cancelled && v) {
          setVisible(true);
          window.clearInterval(interval);
        }
      }).catch(() => {});
    }, VISIBILITY_RETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadVisibility, visible, project?.rootPath, variant]);

  const openQuickView = useCallback(() => {
    if (cachedQuickViewRef.current) {
      setQuickView(cachedQuickViewRef.current);
    }
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    clearLinearQuickViewSelection(project?.rootPath);
    setOpen(false);
  }, [project?.rootPath]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, open]);

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

  const launchBatch = useCallback(async (entries: BatchLaunchSubmit[]) => {
    if (!entries.length) return;
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
        createLane: (args) => window.ade.lanes.create(args),
        // Single headless launch: creates the session and runs the kickoff turn
        // server-side without a mounted chat pane. When the user picked a
        // permission mode it is forwarded; otherwise the IPC defaults to an
        // autonomous-runnable mode.
        launch: (args) =>
          window.ade.agentChat.launch({
            laneId: args.laneId,
            provider: args.provider,
            model: args.model,
            modelId: args.modelId,
            reasoningEffort: args.reasoningEffort,
            ...(args.codexFastMode !== undefined ? { codexFastMode: args.codexFastMode } : {}),
            ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
            kickoffText: args.kickoffText,
            contextAttachments: args.contextAttachments,
          }),
        // CLI-agent variant: spawns a tracked terminal pty with the issue
        // attached so the agent drives it via `ade linear`. Returns the pty
        // session id, which runBatchLaunch records like a chat session id.
        launchCli: (args) =>
          window.ade.agentChat.launchCli({
            laneId: args.laneId,
            provider: args.provider,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
            kickoffPrompt: args.kickoffPrompt,
            linearIssues: args.linearIssues,
          }),
        deleteLane: (args) =>
          window.ade.lanes.delete(args).then(() => undefined),
      },
      {
        onItem: (issueId, patch) => {
          // As soon as an issue reports its materialized lane id, drop its
          // optimistic spinner placeholder — the real lane will render instead.
          if (patch.laneId) clearCreatingIssue(issueId);
          setBatchLaunchStates((current) => {
            const prev = current.get(issueId);
            if (!prev) return current;
            const next = new Map(current);
            next.set(issueId, { ...prev, ...patch });
            return next;
          });
        },
      },
    );
    // Clear any placeholders whose issues failed before a lane materialized so a
    // failed launch never leaves a permanent spinner tab.
    for (const issueId of result.failedIssueIds) clearCreatingIssue(issueId);
    await refreshLanes({ includeStatus: false }).catch(() => undefined);
    if (result.createdLaneIds.length || result.createdSessionIds.length) {
      rememberLaunchedLanes({
        laneIds: result.createdLaneIds,
        sessionIds: result.createdSessionIds,
      });
    }
  }, [launchPromptClipboardEnabled, refreshLanes]);

  const handleBatchLaunch = useCallback((entries: BatchLaunchSubmit[]) => {
    // Close + reroute synchronously; the orchestrator runs detached so the
    // Lanes tab opens immediately rather than this being a progress view.
    setBatchModalOpen(false);
    close();
    window.location.hash = "#/lanes?drawer=stack";
    void launchBatch(entries).catch((err) => {
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
    const entries: BatchLaunchSubmit[] = failed.map((state) => ({
      issue: state.issue,
      config: batchConfigByIssueRef.current.get(state.issue.id) ?? {
        modelId: "",
        reasoningEffort: null,
        codexFastMode: false,
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
    const failed = states.filter((s) => s.status === "failed").length;
    const running = states.some((s) => s.status !== "done" && s.status !== "failed");
    return { total: states.length, completed, failed, running };
  }, [batchLaunchStates]);

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
        className="w-[min(440px,100%)] overflow-hidden rounded-xl border border-white/12 bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
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
                openProjectPickerRoute();
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
      {trigger}
      {connectionPromptModal}

      {open ? createPortal(
        <>
          <button
            type="button"
            aria-label="Close Linear quick view backdrop"
            data-linear-quick-view-backdrop="true"
            className="fixed inset-0 z-[9998] cursor-default bg-black/55 backdrop-blur-md"
            onClick={close}
            tabIndex={-1}
          />
          <div
            ref={popoverRef}
            role="dialog"
            aria-modal="true"
            aria-label="Linear quick view"
            className="fixed left-1/2 top-1/2 z-[9999] flex h-[min(900px,calc(100dvh-28px))] w-[min(1380px,calc(100vw-28px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
            style={{
              borderColor: "rgba(123, 138, 240, 0.55)",
              boxShadow: "0 24px 70px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(123, 138, 240, 0.18)",
            }}
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
            </div>
          </div>
        </>,
        document.body,
      ) : null}

      <BatchLaunchModal
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
        onOpenLane={(laneId) => {
          selectLane(laneId);
          window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&focus=single`;
        }}
      />
    </>
  );
}
