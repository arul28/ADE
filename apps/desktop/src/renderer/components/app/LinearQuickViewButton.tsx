import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CtoLinearQuickView,
  LaneLinearIssue,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import {
  consumePendingLinearPaneOpenRequest,
  subscribeLinearPaneOpenRequests,
} from "../../lib/linearIssueQuickViewNavigation";
import {
  clearPendingLinearLaunchRequest,
  subscribeLinearLaunchRequests,
  takePendingLinearLaunchRequest,
} from "../../lib/linearLaunchRequests";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { cn } from "../ui/cn";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import { LinearPaneModal } from "./LinearPaneModal";
import { requestIssueCreate } from "../../lib/issueCreateRequests";
import { useIssueTopBarPreferences } from "../issues/issueTopBarPreferences";
import {
  clearLinearQuickViewSelection,
  LinearIssueBrowser,
  linearBrowserIssueToLaneIssue,
  type BatchProgress,
} from "./LinearIssueBrowser";
import { buildLinearLaunchIssue, findIssueConflicts } from "../../lib/linearBatchLaunch";
import {
  getIssueLaunchProgress,
  requestIssueLaunch,
  subscribeIssueLaunchCancellations,
  subscribeIssueLaunchProgress,
  subscribeIssueLaunchRequestClosed,
} from "../../lib/issueLaunchRequests";
import { settingsRouteFor } from "../settings/settingsManifest";
import { LINEAR_CONNECTION_CHANGED_EVENT } from "../../lib/linearConnectionEvents";
import { createBackoffPoller } from "../../lib/backoffPoller";

const INITIAL_VISIBILITY_CHECK_DELAY_MS = 2_000;
// A backstop for a connection made outside this window (the CLI, another
// device). Settings in this window announces its changes, and window focus
// re-checks, so the button does not need to ask the brain every 3 s while
// Linear is disconnected.
const VISIBILITY_RETRY_INTERVAL_MS = 60_000;
const REMOTE_VISIBILITY_RETRY_INTERVAL_MS = 15_000;
// While still disconnected the retry backs off toward this cap; a connection
// made here reaches the button at once through the events and focus above.
const DISCONNECTED_VISIBILITY_MAX_INTERVAL_MS = 300_000;
const VISIBILITY_CONNECTED_CACHE_TTL_MS = 60_000;
const VISIBILITY_DISCONNECTED_CACHE_TTL_MS = 1_500;

const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg/90";

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

  if (entry.inFlight) {
    if (!force) return entry.inFlight;
    // A forced read follows a change (a key saved, a connection made); the read
    // in flight may have started before it, so read again once it settles.
    const retry = () => readLinearVisibilityCached({ projectRoot, reader, force });
    return entry.inFlight.then(retry, retry);
  }
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
  const [visible, setVisible] = useState(false);
  const topBarPreferences = useIssueTopBarPreferences();
  const [open, setOpen] = useState(false);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(() => getIssueLaunchProgress());
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cachedQuickViewRef = useRef<CtoLinearQuickView | null>(null);
  const launchRequestNonceRef = useRef<string | null>(null);
  // The pane's own modal hides the native browser while it is open.
  const occludesNativeBrowser = batchModalOpen && !open;
  const activeProjectRoot =
    projectBinding?.kind === "remote" ? projectBinding.rootPath : project?.rootPath;

  useEffect(() => subscribeIssueLaunchProgress((progress) => {
    setBatchProgress(progress);
  }), []);

  useEffect(() => {
    const unsubscribeClosed = subscribeIssueLaunchRequestClosed((nonce) => {
      if (launchRequestNonceRef.current !== nonce) return;
      setBatchModalOpen(false);
    });
    const unsubscribeCancelled = subscribeIssueLaunchCancellations((nonce) => {
      if (launchRequestNonceRef.current !== nonce) return;
      launchRequestNonceRef.current = null;
      setOpen(true);
    });
    return () => {
      unsubscribeClosed();
      unsubscribeCancelled();
    };
  }, []);
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
    window.location.hash = `#${settingsRouteFor("integrations.linear")}`;
  }, []);

  // "Open the Linear pane" from elsewhere (the Issues tool's empty state, the
  // issue sheet). Disconnected: the pane would only say so, so go straight to
  // the place that fixes it.
  const handlePaneOpenRequest = useCallback(() => {
    void loadVisibility({ force: true })
      .then((nextVisible) => {
        setVisible(nextVisible);
        if (nextVisible) {
          if (cachedQuickViewRef.current) setQuickView(cachedQuickViewRef.current);
          setOpen(true);
        } else {
          openLinearSettings();
        }
      })
      .catch(() => {
        setVisible(false);
        openLinearSettings();
      });
  }, [loadVisibility, openLinearSettings]);

  useEffect(() => {
    if (variant !== "icon") return;
    const pending = consumePendingLinearPaneOpenRequest();
    if (pending) handlePaneOpenRequest();
    return subscribeLinearPaneOpenRequests(handlePaneOpenRequest);
  }, [handlePaneOpenRequest, variant]);

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
    window.addEventListener(LINEAR_CONNECTION_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(LINEAR_CONNECTION_CHANGED_EVENT, refresh);
    };
  }, [loadVisibility, activeProjectRoot, shouldAutoCheckVisibility]);

  // Disconnected retry. The poller backs off while the answer stays "not
  // connected", pauses while the page is hidden, and reads at once on return.
  useEffect(() => {
    if (!shouldAutoCheckVisibility) return;
    if (visible) return;
    if (!activeProjectRoot) return;
    // A read still in flight when the project changes answers for the old one.
    let stopped = false;
    const poller = createBackoffPoller({
      baseMs: visibilityRetryIntervalMs,
      maxMs: DISCONNECTED_VISIBILITY_MAX_INTERVAL_MS,
      isActive: () => true,
      read: () => loadVisibility().then((nextVisible) => {
        // Connected: the effect re-runs with `visible` set and stops this poller.
        if (nextVisible && !stopped) setVisible(true);
        return false;
      }),
    });
    poller.start();
    return () => {
      stopped = true;
      poller.stop();
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

  // Linear launch requests join the same app-wide flow as GitHub and Jira.
  // The pane stays mounted long enough to restore its persisted selection if
  // the shared launch dialog is cancelled.
  const handleBatchLaunchOpen = useCallback(
    (issues: Array<NormalizedLinearIssue | LaneLinearIssue>, options: { laneOnly?: boolean; fromPane?: boolean }) => {
      const launchIssues = issues.map((issue) => buildLinearLaunchIssue(
        "raw" in issue ? linearBrowserIssueToLaneIssue(issue) : issue,
      ));
      const request = requestIssueLaunch(launchIssues, {
        laneOnly: options.laneOnly === true,
        returnToLinearPane: options.fromPane !== false,
        ...(onOpenHarnessSettings ? { onOpenHarnessSettings } : {}),
      });
      if (!request) return;
      launchRequestNonceRef.current = request.nonce;
      setBatchModalOpen(true);
      setOpen(false);
    },
    [onOpenHarnessSettings],
  );

  // Launch asked for by the issue viewer (Work tools pane, issue sheet): it
  // enters the shared modal and runner too.
  useEffect(() => {
    if (variant !== "icon") return;
    const pending = takePendingLinearLaunchRequest();
    if (pending) handleBatchLaunchOpen(pending.issues, { laneOnly: pending.laneOnly, fromPane: false });
    return subscribeLinearLaunchRequests((request) => {
      clearPendingLinearLaunchRequest();
      handleBatchLaunchOpen(request.issues, { laneOnly: request.laneOnly, fromPane: false });
    });
  }, [handleBatchLaunchOpen, variant]);

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

  const handleToggle = () => {
    if (open) {
      close();
      return;
    }
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
      {showTrigger && visible && topBarPreferences.linear ? trigger : null}

      <LinearPaneModal
        open={open}
        ariaLabel="Linear quick view"
        quickView={quickView}
        loading={browserLoading}
        onRefresh={() => setRefreshKey((key) => key + 1)}
        onNew={() => requestIssueCreate({ provider: "linear", origin: "pane" })}
        newTitle="New Linear issue"
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

    </>
  );
}
