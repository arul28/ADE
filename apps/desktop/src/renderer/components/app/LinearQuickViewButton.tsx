import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, Warning, X } from "@phosphor-icons/react";

import type {
  CtoLinearQuickView,
  LaneLinearIssue,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { linearIssueBranchName, linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { useAppStore } from "../../state/appStore";
import { requestLinearIssueWorkContext } from "../../lib/linearIssueWorkNavigation";
import {
  consumePendingLinearIssueQuickViewRequest,
  subscribeLinearIssueQuickViewRequests,
  type LinearIssueQuickViewRequest,
} from "../../lib/linearIssueQuickViewNavigation";
import { cn } from "../ui/cn";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import { LinearIssueBrowser, linearBrowserIssueToLaneIssue } from "./LinearIssueBrowser";
import {
  BatchCreateLanesModal,
  BatchResolveInExistingLaneModal,
  BatchResolveInNewLanesModal,
  CreateLaneAttachedModal,
  ResolveInExistingLaneModal,
  ResolveInNewLaneModal,
  useLinearIssueResolveModalState,
  type LinearIssueResolveModalKind,
} from "./LinearIssueResolveModals";

const INITIAL_VISIBILITY_CHECK_DELAY_MS = 2_000;

const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg/90";

function openWorkDraftForLinearIssue(args: {
  projectRoot: string | null | undefined;
  laneId: string;
  issue: LaneLinearIssue;
  contextSource: "lane_link" | "manual";
  modelId?: string | null;
  selectLane: (laneId: string) => void;
  setWorkViewState: ReturnType<typeof useAppStore.getState>["setWorkViewState"];
  setLaneWorkViewState: ReturnType<typeof useAppStore.getState>["setLaneWorkViewState"];
}): void {
  requestLinearIssueWorkContext({
    laneId: args.laneId,
    issue: args.issue,
    contextSource: args.contextSource,
    modelId: args.modelId ?? null,
  });
  args.selectLane(args.laneId);
  const draftState = {
    draftKind: "chat" as const,
    draftLaneId: args.laneId,
    viewMode: "tabs" as const,
    activeItemId: null,
    selectedItemId: null,
  };
  args.setWorkViewState(args.projectRoot, draftState);
  args.setLaneWorkViewState(args.projectRoot, args.laneId, draftState);
  window.location.hash = `#/work?laneId=${encodeURIComponent(args.laneId)}`;
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
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const setLaneWorkViewState = useAppStore((s) => s.setLaneWorkViewState);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const [quickViewRequest, setQuickViewRequest] = useState<LinearIssueQuickViewRequest | null>(null);
  const [connectionPrompt, setConnectionPrompt] = useState<LinearIssueQuickViewRequest | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [busyModal, setBusyModal] = useState<LinearIssueResolveModalKind | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    completed: number;
    total: number;
    action: string;
  } | null>(null);
  const { activeModal, activeIssue, openModal, closeModal } = useLinearIssueResolveModalState();
  const [batchModal, setBatchModal] = useState<"batch-create-lanes" | "batch-resolve-new" | "batch-resolve-existing" | null>(null);
  const [batchIssues, setBatchIssues] = useState<LaneLinearIssue[]>([]);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const cachedQuickViewRef = useRef<CtoLinearQuickView | null>(null);

  const loadVisibility = useCallback(async (): Promise<boolean> => {
    if (!project?.rootPath || !window.ade.cto?.getLinearConnectionStatus) {
      return false;
    }
    const status = await window.ade.cto.getLinearConnectionStatus();
    return status.connected === true;
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
  }, [loadVisibility, project?.rootPath]);

  useEffect(() => {
    const onBridge = () => {
      void loadVisibility()
        .then(setVisible)
        .catch(() => setVisible(false));
    };
    // If bridge already fired before this effect registered, check now
    if ((window as any).__adeRuntimeBridge) {
      onBridge();
    }
    window.addEventListener("ade:runtime-bridge-ready", onBridge);
    return () => window.removeEventListener("ade:runtime-bridge-ready", onBridge);
  }, [loadVisibility]);

  useEffect(() => {
    if (!project?.rootPath) return;
    let cancelled = false;
    const refresh = () => {
      void loadVisibility()
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
  }, [loadVisibility, project?.rootPath]);

  useEffect(() => {
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
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadVisibility, visible, project?.rootPath]);

  const openQuickView = useCallback(() => {
    if (cachedQuickViewRef.current) {
      setQuickView(cachedQuickViewRef.current);
    }
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    closeModal();
  }, [closeModal]);

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

  const createLaneForIssue = useCallback(async (issue: LaneLinearIssue) => {
    const name = linearIssueLaneName(issue);
    const branchName = linearIssueBranchName(issue);
    const lane = await window.ade.lanes.create({
      name,
      branchName,
      linearIssue: { ...issue, branchName },
    });
    await refreshLanes({ includeStatus: false }).catch(() => undefined);
    return lane;
  }, [refreshLanes]);

  const openLaneInLanesTab = useCallback((laneId: string) => {
    selectLane(laneId);
    close();
    window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&focus=single`;
  }, [close, selectLane]);

  const openWorkDraft = useCallback((
    laneId: string,
    issue: LaneLinearIssue,
    contextSource: "lane_link" | "manual",
    modelId?: string | null,
  ) => {
    openWorkDraftForLinearIssue({
      projectRoot: project?.rootPath,
      laneId,
      issue,
      contextSource,
      modelId,
      selectLane,
      setWorkViewState,
      setLaneWorkViewState,
    });
    close();
  }, [close, project?.rootPath, selectLane, setLaneWorkViewState, setWorkViewState]);

  const handleCreateLaneAttached = useCallback(async () => {
    if (!activeIssue) return;
    setBusyModal("create-lane");
    try {
      const lane = await createLaneForIssue(activeIssue);
      openLaneInLanesTab(lane.id);
      closeModal();
    } finally {
      setBusyModal(null);
    }
  }, [activeIssue, closeModal, createLaneForIssue, openLaneInLanesTab]);

  const handleResolveInNewLane = useCallback(async (modelId: string) => {
    if (!activeIssue) return;
    setBusyModal("resolve-new-lane");
    try {
      const lane = await createLaneForIssue(activeIssue);
      openWorkDraft(lane.id, activeIssue, "lane_link", modelId);
      closeModal();
    } finally {
      setBusyModal(null);
    }
  }, [activeIssue, closeModal, createLaneForIssue, openWorkDraft]);

  const handleResolveInExistingLane = useCallback(async (laneId: string, modelId: string) => {
    if (!activeIssue) return;
    setBusyModal("resolve-existing-lane");
    try {
      openWorkDraft(laneId, activeIssue, "manual", modelId);
      closeModal();
    } finally {
      setBusyModal(null);
    }
  }, [activeIssue, closeModal, openWorkDraft]);

  const handleResolveModalOpen = useCallback(
    (kind: LinearIssueResolveModalKind, issue: NormalizedLinearIssue | LaneLinearIssue) => {
      openModal(kind, linearBrowserIssueToLaneIssue(issue));
      setOpen(false); // Close the Linear pane so the modal is visible
    },
    [openModal],
  );

  const openBatchModal = useCallback((modal: NonNullable<typeof batchModal>, issues: Array<NormalizedLinearIssue | LaneLinearIssue>) => {
    setBatchIssues(issues.map((i) => "raw" in i ? linearBrowserIssueToLaneIssue(i) : i as LaneLinearIssue));
    setOpen(false);
    setBatchModal(modal);
  }, []);

  const handleBatchCreateLanes = useCallback(
    (issues: Array<NormalizedLinearIssue | LaneLinearIssue>) => openBatchModal("batch-create-lanes", issues),
    [openBatchModal],
  );
  const handleBatchResolveNewLanes = useCallback(
    (issues: Array<NormalizedLinearIssue | LaneLinearIssue>) => openBatchModal("batch-resolve-new", issues),
    [openBatchModal],
  );
  const handleBatchResolveExistingLane = useCallback(
    (issues: Array<NormalizedLinearIssue | LaneLinearIssue>) => openBatchModal("batch-resolve-existing", issues),
    [openBatchModal],
  );

  const confirmBatchCreateLanes = useCallback(async () => {
    setBusyModal("create-lane");
    setBatchProgress({ completed: 0, total: batchIssues.length, action: "Creating lanes" });
    try {
      for (let i = 0; i < batchIssues.length; i++) {
        await createLaneForIssue(batchIssues[i]);
        setBatchProgress({ completed: i + 1, total: batchIssues.length, action: "Creating lanes" });
      }
      setBatchModal(null);
      close();
      window.location.hash = "#/lanes";
    } catch (err) {
      console.error("[Linear] Batch create lanes failed:", err);
      setBatchModal(null);
    } finally {
      setBusyModal(null);
      setBatchProgress(null);
    }
  }, [batchIssues, close, createLaneForIssue]);

  const confirmBatchResolveNewLanes = useCallback(async (modelId: string) => {
    setBusyModal("resolve-new-lane");
    setBatchProgress({ completed: 0, total: batchIssues.length, action: "Creating lanes + chats" });
    try {
      for (let i = 0; i < batchIssues.length; i++) {
        const lane = await createLaneForIssue(batchIssues[i]);
        openWorkDraft(lane.id, batchIssues[i], "lane_link", modelId);
        setBatchProgress({ completed: i + 1, total: batchIssues.length, action: "Creating lanes + chats" });
      }
      setBatchModal(null);
    } catch (err) {
      console.error("[Linear] Batch resolve (new lanes) failed:", err);
      setBatchModal(null);
    } finally {
      setBusyModal(null);
      setBatchProgress(null);
    }
  }, [batchIssues, createLaneForIssue, openWorkDraft]);

  const confirmBatchResolveExistingLane = useCallback(async (laneId: string, modelId: string) => {
    setBusyModal("resolve-existing-lane");
    setBatchProgress({ completed: 0, total: batchIssues.length, action: "Assigning to lane" });
    try {
      for (let i = 0; i < batchIssues.length; i++) {
        openWorkDraft(laneId, batchIssues[i], "manual", modelId);
        setBatchProgress({ completed: i + 1, total: batchIssues.length, action: "Assigning to lane" });
      }
      setBatchModal(null);
    } catch (err) {
      console.error("[Linear] Batch resolve (existing lane) failed:", err);
      setBatchModal(null);
    } finally {
      setBusyModal(null);
      setBatchProgress(null);
    }
  }, [batchIssues, openWorkDraft]);

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
            className="fixed inset-0 z-[9998] cursor-default bg-black/30 backdrop-blur-sm"
            onClick={close}
            tabIndex={-1}
          />
          <div
            ref={popoverRef}
            role="dialog"
            aria-modal="true"
            aria-label="Linear quick view"
            className="fixed left-1/2 top-1/2 z-[9999] flex max-h-[min(760px,calc(100vh-64px))] w-[min(1040px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
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
                resolveActions={{
                  onOpenModal: handleResolveModalOpen,
                  busyModal,
                  disabled: Boolean(busyModal),
                }}
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
                  onBatchCreateLanes: handleBatchCreateLanes,
                  onBatchResolveNewLanes: handleBatchResolveNewLanes,
                  onBatchResolveExistingLane: handleBatchResolveExistingLane,
                  batchProgress,
                }}
              />
            </div>
          </div>
        </>,
        document.body,
      ) : null}

      <CreateLaneAttachedModal
        open={activeModal === "create-lane"}
        issue={activeIssue}
        busy={busyModal === "create-lane"}
        onOpenChange={(next) => { if (!next) closeModal(); }}
        onConfirm={handleCreateLaneAttached}
      />
      <ResolveInNewLaneModal
        open={activeModal === "resolve-new-lane"}
        issue={activeIssue}
        busy={busyModal === "resolve-new-lane"}
        onOpenChange={(next) => { if (!next) closeModal(); }}
        onConfirm={handleResolveInNewLane}
      />
      <ResolveInExistingLaneModal
        open={activeModal === "resolve-existing-lane"}
        issue={activeIssue}
        lanes={lanes}
        busy={busyModal === "resolve-existing-lane"}
        onOpenChange={(next) => { if (!next) closeModal(); }}
        onConfirm={handleResolveInExistingLane}
      />

      <BatchCreateLanesModal
        open={batchModal === "batch-create-lanes"}
        issues={batchIssues}
        busy={Boolean(busyModal)}
        onOpenChange={(next) => { if (!next) setBatchModal(null); }}
        onConfirm={() => void confirmBatchCreateLanes()}
      />
      <BatchResolveInNewLanesModal
        open={batchModal === "batch-resolve-new"}
        issues={batchIssues}
        busy={Boolean(busyModal)}
        onOpenChange={(next) => { if (!next) setBatchModal(null); }}
        onConfirm={(modelId) => void confirmBatchResolveNewLanes(modelId)}
      />
      <BatchResolveInExistingLaneModal
        open={batchModal === "batch-resolve-existing"}
        issues={batchIssues}
        lanes={lanes}
        busy={Boolean(busyModal)}
        onOpenChange={(next) => { if (!next) setBatchModal(null); }}
        onConfirm={(laneId, modelId) => void confirmBatchResolveExistingLane(laneId, modelId)}
      />
    </>
  );
}
