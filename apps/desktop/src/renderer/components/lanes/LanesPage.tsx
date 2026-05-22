import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { Check, CaretDown, FileCode, GitBranch, GitPullRequest, Stack, Link, ArrowsOutSimple, ArrowsInSimple, PushPin, Plus, MagnifyingGlass, Terminal, X, ArrowSquareOut, Info, ArrowCounterClockwise, UsersThree, CircleNotch } from "@phosphor-icons/react";
import { useAppStore, useAppStoreApi, type LaneInspectorTab } from "../../state/appStore";
import { buildIntegrationSourcesByLaneId } from "../../lib/integrationLanes";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { PaneTilingLayout } from "../ui/PaneTilingLayout";
import { useDockLayout } from "../ui/DockLayoutState";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";
import { ResizeGutter } from "../ui/ResizeGutter";
import { LaneStackPane } from "./LaneStackPane";
import { LaneGitActionsPane } from "./LaneGitActionsPane";
import { LaneWorkPane } from "./LaneWorkPane";
import { QuickRunMenu } from "../run/QuickRunMenu";
import { CreateLaneDialog, type CreateLaneMode, type CreateLaneSetupStep } from "./CreateLaneDialog";
import { AttachLaneDialog } from "./AttachLaneDialog";
import { MultiAttachWorktreeDialog } from "./MultiAttachWorktreeDialog";
import { ManageLaneDialog } from "./ManageLaneDialog";
import { LaneContextMenu } from "./LaneContextMenu";
import { getLaneAccent } from "./laneColorPalette";
import { LaneRebaseBanner } from "./LaneRebaseBanner";
import { LinearIssueBadge } from "./LinearIssueBadge";
import { HelpChip } from "../onboarding/HelpChip";
import { useOnboardingStore } from "../../state/onboardingStore";
import { useDialogBus } from "../../lib/useDialogBus";
import {
  buildLaneActionClearedSearch,
  parseLaneIdsParam,
  laneHasAncestor,
  planLaneDeleteBatches,
  resolveCreateLaneRequest,
  resolveLaneDeleteStartSelection,
  resolveLaneIdsDeepLinkSelection,
  resolveVisibleLaneIds,
  runLaneDeleteBatchSequentially,
  selectLaneTabPrTag,
  shouldApplyLaneIdsDeepLink,
  sortLaneListRows,
  type LaneTabPrTag,
} from "./lanePageModel";
import {
  sortLanesForTabs,
  sortLanesForStackGraph,
  mergeUnique,
  laneMatchesFilter,
  isMissionLaneHiddenByDefault,
  isMissionResultLane,
  LANES_TILING_TREE,
  LANES_TILING_WORK_FOCUS_TREE,
  LANES_TILING_LAYOUT_VERSION,
  GIT_ACTIONS_FULLSCREEN_TREE,
  RESIZE_TARGET_MINIMUM_SIZE,
  EMPTY_LANE_PANE_DETAIL,
  formatBranchCheckoutError,
  validateBranchName,
  stripRemotePrefix,
  type LanePaneDetailSelection,
  type LaneBranchOption
} from "./laneUtils";
import { buildPrsRouteSearch } from "../prs/prsRouteState";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { getProjectConfigCached } from "../../lib/projectConfigCache";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { linearIssueBranchName, linearIssueLaneName } from "../../../shared/linearIssueBranch";
import type {
  BranchPullRequest,
  DeleteLaneArgs,
  GitCommitSummary,
  GitHubPrListItem,
  LaneEnvInitEvent,
  LaneEnvInitProgress,
  LaneBranchActiveWorkItem,
  LaneListSnapshot,
  LaneLinearIssue,
  LaneRuntimePlacement,
  LaneSummary,
  MacosVmStatus,
  MacosVmEventPayload,
  PrSummary,
  RebaseRun,
  RebaseScope,
  IntegrationProposal,
  LaneDeleteProgress,
  LaneTemplate
} from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { SmartTooltip } from "../ui/SmartTooltip";
import { docs } from "../../onboarding/docsLinks";
import {
  fallbackMacosVmGuestReadiness,
  macosVmGuestReadinessLabel,
  macosVmIsRuntimeReady,
  readMacosVmRuntimeAuthConfirmed,
} from "../../lib/macosVmRuntimeReadiness";

type RebaseScopePromptState = {
  laneId: string;
  laneName: string;
  resolve: (scope: RebaseScope | null) => void;
};

type LanePaneSurface = "inline" | "git-actions-fullscreen" | "lane-fullscreen";
type CreateSetupPhase =
  | "creating"
  | "appearance"
  | "refreshing"
  | "starting-vm"
  | "environment";

export function shouldMountGitActionsPane({
  laneId,
  expandedGitActionsLaneId,
  surface,
}: {
  laneId: string | null;
  expandedGitActionsLaneId: string | null;
  surface: LanePaneSurface;
}): boolean {
  return surface !== "inline" || !laneId || expandedGitActionsLaneId !== laneId;
}

type RebasePushReviewState = {
  runId: string;
  lanes: Array<{ laneId: string; laneName: string; selected: boolean }>;
  resolve: (laneIds: string[] | null) => void;
};

const ADOPT_HINT_DISMISSED_KEY = "ade.lanes.adoptHintDismissed.v1";
const LANE_DELETE_REFRESH_DEBOUNCE_MS = 160;

function normalizeLaneRuntimePlacement(value: unknown): LaneRuntimePlacement {
  return value === "macos-vm" ? "macos-vm" : "local";
}

export function createVmRuntimeStatusReason({
  loading,
  status,
  error,
}: {
  loading: boolean;
  status: MacosVmStatus | null;
  error: string | null;
}): string | null {
  if (loading) return "Checking VM setup...";
  if (error) return error;
  if (!status) return "Set up your Mac VM first.";
  if (!status.supported) return "Mac VMs require ADE on Apple silicon macOS.";
  if (!status.activeProvider.available) return status.activeProvider.detail || "Install Lume from the VM tab first.";
  if (status.vms.some((vm) => vm.laneState === "missing")) return "Remove the stale VM attachment from the VM tab before creating another VM lane.";
  const vm = status.vms[0] ?? status.laneVm ?? null;
  if (!vm) return "Set up your Mac VM first.";
  const readiness = fallbackMacosVmGuestReadiness(vm);
  if (!macosVmIsRuntimeReady(readiness)) {
    return `Finish Mac VM setup first (current phase: ${macosVmGuestReadinessLabel(readiness.state)}).`;
  }
  return null;
}

function getDevicePresenceTitle(devicesOpen: LaneSummary["devicesOpen"]): string {
  const names = (devicesOpen ?? [])
    .map((device) => device.displayName.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return "Open on this device";
  if (names.length === 1) return `Open on ${names[0]}`;
  return `Open on ${names.length} devices: ${names.join(", ")}`;
}

function DeferredLanePane({
  cacheKey,
  label,
  children,
}: {
  cacheKey: string;
  label: string;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const timer = window.setTimeout(() => {
      setReady(true);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [cacheKey]);

  if (ready) return <>{children}</>;

  return (
    <div
      className="flex h-full items-center justify-center"
      style={{ background: COLORS.cardBg, color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 11 }}
    >
      Preparing {label.toUpperCase()} pane...
    </div>
  );
}

function lanePrTagColor(state: PrSummary["state"]): string {
  if (state === "merged") return COLORS.success;
  if (state === "closed") return COLORS.danger;
  if (state === "draft") return COLORS.warning;
  return COLORS.accent;
}

function isTrustedGitHubUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

export function isLaneDeleteProgressActive(progress: LaneDeleteProgress | null | undefined): boolean {
  return progress?.overallStatus === "running"
    || progress?.overallStatus === "completed"
    || progress?.overallStatus === "completed_with_warnings";
}

export function buildLaneSplitColumnsKey(args: {
  laneTilingLayoutSuffix: string;
  gridResetKey: number;
}): string {
  return `lanes-split-columns:${args.laneTilingLayoutSuffix}:${args.gridResetKey}`;
}

function LaneLoadingSkeleton() {
  const tabWidths = [118, 96, 132, 88];
  const rowWidths = [88, 72, 104, 80, 96];
  const paneWidths = [76, 92, 68, 84];
  const skeletonBlock = (width: number | string, height: number, extra?: React.CSSProperties): React.CSSProperties => ({
    width,
    height,
    borderRadius: 6,
    background: "color-mix(in srgb, var(--color-fg) 7%, transparent)",
    border: `1px solid ${COLORS.borderMuted}`,
    ...extra,
  });

  return (
    <div
      data-testid="lanes-loading-skeleton"
      aria-label="Loading lanes"
      className="flex min-h-0 flex-1 flex-col"
      style={{ background: COLORS.pageBg }}
    >
      <div
        className="flex h-11 shrink-0 items-center gap-2 overflow-hidden px-3"
        style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}
      >
        {tabWidths.map((width, index) => (
          <div
            key={`lane-loading-tab-${index}`}
            className="animate-pulse"
            style={skeletonBlock(width, 24, { borderRadius: 7 })}
          />
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(190px,280px)_minmax(0,1fr)]">
        <div
          className="min-h-0 overflow-hidden p-3"
          style={{
            borderRight: `1px solid ${COLORS.border}`,
            background: "color-mix(in srgb, var(--color-bg) 94%, var(--color-fg) 6%)",
          }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="animate-pulse" style={skeletonBlock(78, 12, { borderRadius: 4 })} />
            <div className="animate-pulse" style={skeletonBlock(32, 18)} />
          </div>
          <div className="space-y-2">
            {rowWidths.map((width, index) => (
              <div
                key={`lane-loading-row-${index}`}
                className="animate-pulse"
                style={{
                  padding: "10px 10px",
                  borderRadius: 8,
                  border: `1px solid ${COLORS.borderMuted}`,
                  background: COLORS.cardBg,
                }}
              >
                <div style={skeletonBlock(width, 10, { border: "none" })} />
                <div className="mt-2" style={skeletonBlock(`${Math.max(38, width - 28)}%`, 7, { border: "none", opacity: 0.6 })} />
              </div>
            ))}
          </div>
        </div>
        <div className="min-h-0 overflow-hidden p-4">
          <div className="mb-4 flex items-center gap-2">
            {paneWidths.map((width, index) => (
              <div
                key={`lane-loading-pane-tab-${index}`}
                className="animate-pulse"
                style={skeletonBlock(width, 26, { borderRadius: 7 })}
              />
            ))}
          </div>
          <div className="grid h-[calc(100%-42px)] min-h-0 grid-cols-2 gap-3">
            {[0, 1, 2, 3].map((index) => (
              <div
                key={`lane-loading-pane-${index}`}
                className="animate-pulse"
                style={{
                  minHeight: 0,
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.cardBg,
                  padding: 12,
                }}
              >
                <div style={skeletonBlock(index % 2 === 0 ? 94 : 72, 11, { border: "none" })} />
                <div className="mt-4 space-y-2">
                  <div style={skeletonBlock("88%", 8, { border: "none", opacity: 0.7 })} />
                  <div style={skeletonBlock("64%", 8, { border: "none", opacity: 0.55 })} />
                  <div style={skeletonBlock("74%", 8, { border: "none", opacity: 0.45 })} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function createPendingDeleteProgress(laneId: string): LaneDeleteProgress {
  return {
    laneId,
    steps: [],
    startedAt: new Date().toISOString(),
    overallStatus: "running",
    cancellable: false,
  };
}

function getLaneDeleteStatusLabel(progress: LaneDeleteProgress | null | undefined): string {
  if (progress?.overallStatus === "completed_with_warnings") return "Deleted with warnings";
  return progress?.overallStatus === "completed" ? "Deleted" : "Deleting";
}

const LANE_DELETE_STEP_LABELS: Record<string, string> = {
  git_status: "dirty-state check",
  cancel_auto_rebase: "auto-rebase cancellation",
  stop_processes: "process shutdown",
  stop_ptys: "terminal shutdown",
  stop_watchers: "file watcher shutdown",
  cleanup_env: "environment cleanup",
  git_worktree_remove: "worktree removal",
  git_branch_delete: "local branch delete",
  git_remote_branch_delete: "remote branch delete",
  pack_dir_remove: "pack folder cleanup",
  database_cleanup: "database cleanup",
};

function formatLaneDeleteProgressError(progress: LaneDeleteProgress, laneName: string): string {
  const failedStep = progress.steps.find((step) => step.status === "failed");
  const warningSteps = progress.steps.filter((step) => step.status === "warning");
  if (failedStep) {
    const label = LANE_DELETE_STEP_LABELS[failedStep.name] ?? failedStep.name;
    const detail = failedStep.errorMessage ? `: ${failedStep.errorMessage}` : "";
    return `${laneName} delete failed during ${label}${detail}`;
  }
  if (warningSteps.length > 0) {
    const first = warningSteps[0]!;
    const label = LANE_DELETE_STEP_LABELS[first.name] ?? first.name;
    const detail = first.errorMessage ? `: ${first.errorMessage}` : "";
    const extra = warningSteps.length > 1 ? ` (+${warningSteps.length - 1} more)` : "";
    return `${laneName} was deleted, but ${label} needs attention${detail}${extra}`;
  }
  return `${laneName} delete failed.`;
}

function formatLaneDeleteWarningMessages(messagesByLaneId: Map<string, string>): string | null {
  const messages = [...messagesByLaneId.values()];
  return messages.length > 0 ? messages.join("\n") : null;
}

function laneTilingLayoutIds(laneId: string): string[] {
  return [
    `lanes:tiling:${LANES_TILING_LAYOUT_VERSION}:${laneId}`,
    `lanes:tiling:${LANES_TILING_LAYOUT_VERSION}:wf:${laneId}`,
    `lanes:tiling:v6:${laneId}`,
    `lanes:tiling:v6:wf:${laneId}`,
    `lanes:tiling:v7:${laneId}`,
    `lanes:tiling:v7:wf:${laneId}`,
    `lanes:tiling:v8:${laneId}`,
    `lanes:tiling:v8:wf:${laneId}`,
  ];
}

/* ---- Component ---- */

export function LanesPage({ active = true }: { active?: boolean } = {}) {
  const appStore = useAppStoreApi();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const lanes = useAppStore((s) => s.lanes);
  const lanesLoading = useAppStore((s) => s.lanesLoading);

  const urlLaneDeeplinks = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return {
      action: p.get("action"),
      laneIdsRaw: p.get("laneIds"),
      laneId: p.get("laneId"),
      sessionId: p.get("sessionId"),
      inspectorTab: p.get("inspectorTab"),
      focus: p.get("focus"),
      runtimePlacement: p.get("runtimePlacement"),
    };
  }, [location.search]);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const clearLaneInspectorTab = useAppStore((s) => s.clearLaneInspectorTab);
  const setLaneWorkViewState = useAppStore((s) => s.setLaneWorkViewState);
  const keybindings = useAppStore((s) => s.keybindings);
  const project = useAppStore((s) => s.project);
  const activeTourId = useOnboardingStore((s) => s.activeTourId);
  const suppressTourDistractions = activeTourId === "first-journey";

  const [activeLaneIds, setActiveLaneIds] = useState<string[]>([]);
  const [pinnedLaneIds, setPinnedLaneIds] = useState<Set<string>>(new Set());
  const [pulsingLaneId, setPulsingLaneId] = useState<string | null>(null);
  const [gridResetKey, setGridResetKey] = useState(0);
  const [laneFilter, setLaneFilter] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLaneName, setCreateLaneName] = useState("");
  const [createParentLaneId, setCreateParentLaneId] = useState<string>("");
  const [createMode, setCreateMode] = useState<CreateLaneMode>("primary");
  const [createRuntimePlacement, setCreateRuntimePlacement] = useState<LaneRuntimePlacement>("local");
  const [createVmStatus, setCreateVmStatus] = useState<MacosVmStatus | null>(null);
  const [createVmStatusLoading, setCreateVmStatusLoading] = useState(false);
  const [createVmStatusError, setCreateVmStatusError] = useState<string | null>(null);
  const [createVmRuntimeAuthConfirmed, setCreateVmRuntimeAuthConfirmed] = useState(readMacosVmRuntimeAuthConfirmed);
  const [createBaseBranch, setCreateBaseBranch] = useState("");
  const [createImportBranch, setCreateImportBranch] = useState("");
  const [createChildBaseBranch, setCreateChildBaseBranch] = useState("");
  const [createBranches, setCreateBranches] = useState<LaneBranchOption[]>([]);
  const [createBranchesLoading, setCreateBranchesLoading] = useState(false);
  const [createBranchPullRequests, setCreateBranchPullRequests] = useState<BranchPullRequest[]>([]);
  const [createBranchPullRequestsLoading, setCreateBranchPullRequestsLoading] = useState(false);
  const [createGitUserName, setCreateGitUserName] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createEnvInitProgress, setCreateEnvInitProgress] = useState<LaneEnvInitProgress | null>(null);
  const [laneCreated, setLaneCreated] = useState(false);
  const [createSetupPhase, setCreateSetupPhase] = useState<CreateSetupPhase | null>(null);
  const [createVmSetupDetail, setCreateVmSetupDetail] = useState<string | null>(null);
  const createEnvInitLaneIdRef = useRef<string | null>(null);
  const createBaseBranchUserPickedRef = useRef(false);
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [createSelectedColor, setCreateSelectedColor] = useState<string | null>(null);
  const [createSelectedLinearIssue, setCreateSelectedLinearIssue] = useState<LaneLinearIssue | null>(null);
  const createLinearIssueAutoNameRef = useRef<string | null>(null);
  const [multiAttachOpen, setMultiAttachOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachName, setAttachName] = useState("");
  const [attachPath, setAttachPath] = useState("");
  const [attachDescription, setAttachDescription] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const canCreateLane = Boolean(project?.rootPath);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false);
  const [adoptTargetLaneId, setAdoptTargetLaneId] = useState<string | null>(null);
  const [adoptHintDismissed, setAdoptHintDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ADOPT_HINT_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [deleteMode, setDeleteMode] = useState<"worktree" | "local_branch" | "remote_branch">("worktree");
  const [deleteRemoteName, setDeleteRemoteName] = useState("origin");
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | "adopt" | null>(null);
  const deleteProgressByLaneId = useAppStore((s) => s.laneDeleteProgressByLaneId);
  const setDeleteProgressByLaneId = useAppStore((s) => s.setLaneDeleteProgressByLaneId);
  const laneDeleteWarningMessagesRef = useRef<Map<string, string>>(new Map());
  const [managedLaneIds, setManagedLaneIds] = useState<string[]>([]);
  const lanePrTagsRequestRef = useRef(0);
  const laneGithubPrTagsRequestRef = useRef(0);
  const hasActiveLaneRuntimeRef = useRef(false);
  const [autoRebaseEnabled, setAutoRebaseEnabled] = useState(false);
  const [rebaseSuggestionError, setRebaseSuggestionError] = useState<string | null>(null);
  const [rebaseScopePrompt, setRebaseScopePrompt] = useState<RebaseScopePromptState | null>(null);
  const [rebasePushReview, setRebasePushReview] = useState<RebasePushReviewState | null>(null);

  const [laneBranches, setLaneBranches] = useState<LaneBranchOption[]>([]);
  const [laneBranchesLoading, setLaneBranchesLoading] = useState(false);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchCheckoutBusy, setBranchCheckoutBusy] = useState(false);
  const [branchCheckoutError, setBranchCheckoutError] = useState<string | null>(null);
  const [branchSearchQuery, setBranchSearchQuery] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchStartPoint, setNewBranchStartPoint] = useState("");
  const [newBranchBaseRef, setNewBranchBaseRef] = useState("");
  const [newBranchFormOpen, setNewBranchFormOpen] = useState(false);
  const [pendingBranchSwitch, setPendingBranchSwitch] = useState<{
    branchName: string;
    mode: "existing" | "create";
    startPoint?: string;
    baseRef?: string;
    activeWork: LaneBranchActiveWorkItem[];
  } | null>(null);
  const branchSearchInputRef = useRef<HTMLInputElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const completedLaneDeleteRefreshesRef = useRef<Set<string>>(new Set());
  const pendingLaneDeleteRefreshIdsRef = useRef<Set<string>>(new Set());
  const laneDeleteRefreshTimerRef = useRef<number | null>(null);
  const hydratedLaneDeleteProgressProjectRef = useRef<string | null>(null);
  const deleteProgressProjectRootRef = useRef<string | null>(project?.rootPath ?? null);
  const activeLanePresenceSignatureRef = useRef<string | null>(null);
  // Refs for the onDeleteEvent IPC handler. Capturing high-churn values
  // (selectedLaneId, lanesById, managedLaneIds, manageOpen) in refs lets the
  // subscription useEffect keep its dep array minimal so it doesn't tear down
  // and re-subscribe to the IPC bridge on every render.
  const selectedLaneIdRef = useRef<string | null>(null);
  const lanesByIdRef = useRef<Map<string, LaneSummary> | null>(null);
  const managedLaneIdsRef = useRef<string[]>([]);
  const manageOpenRef = useRef<boolean>(false);

  const [addLaneDropdownOpen, setAddLaneDropdownOpen] = useState(false);
  const addLaneDropdownRef = useRef<HTMLDivElement>(null);
  const [stackGraphHeaderOpen, setStackGraphHeaderOpen] = useState(false);
  const stackGraphHeaderRef = useRef<HTMLDivElement>(null);

  const { layout: laneColumnLayout, saveLayout: saveLaneColumnLayout } = useDockLayout("lanes:columns:v1", {});

  const [lanePaneDetails, setLanePaneDetails] = useState<Record<string, LanePaneDetailSelection>>({});
  const [laneContextMenu, setLaneContextMenu] = useState<{ laneId: string; x: number; y: number } | null>(null);
  const [expandedLaneId, setExpandedLaneId] = useState<string | null>(null);
  const [expandedGitActionsLaneId, setExpandedGitActionsLaneId] = useState<string | null>(null);
  const [integrationProposals, setIntegrationProposals] = useState<IntegrationProposal[]>([]);
  const [lanePrTags, setLanePrTags] = useState<PrSummary[]>([]);
  const [laneGithubPrTags, setLaneGithubPrTags] = useState<GitHubPrListItem[]>([]);
  const [linearIssueChatContextRequest, setLinearIssueChatContextRequest] = useState<{
    laneId: string;
    issue: LaneLinearIssue;
    requestedAt: number;
  } | null>(null);
  const laneSnapshots = useAppStore((s) => s.laneSnapshots);
  const consumedLaneIdsDeepLinkSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    logRendererDebugEvent("renderer.lanes.page_mount");
    return () => {
      logRendererDebugEvent("renderer.lanes.page_unmount");
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const projectRoot = project?.rootPath ?? null;
    const previousProjectRoot = deleteProgressProjectRootRef.current;
    deleteProgressProjectRootRef.current = projectRoot;
    hydratedLaneDeleteProgressProjectRef.current = null;
    completedLaneDeleteRefreshesRef.current.clear();
    pendingLaneDeleteRefreshIdsRef.current.clear();
    if (laneDeleteRefreshTimerRef.current != null) {
      window.clearTimeout(laneDeleteRefreshTimerRef.current);
      laneDeleteRefreshTimerRef.current = null;
    }
    if (previousProjectRoot !== projectRoot) {
      setDeleteProgressByLaneId({});
    }
  }, [project?.rootPath, setDeleteProgressByLaneId]);

  const laneSnapshotByLaneId = useMemo(
    () => new Map(laneSnapshots.map((snapshot) => [snapshot.lane.id, snapshot] as const)),
    [laneSnapshots],
  );
  const sortedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const lanePrBranchSignature = useMemo(
    () => sortedLanes
      .map((lane) => `${lane.id}:${lane.laneType}:${lane.branchRef ?? ""}:${lane.baseRef ?? ""}`)
      .sort()
      .join("\0"),
    [sortedLanes],
  );
  const lanesById = useMemo(() => new Map(sortedLanes.map((lane) => [lane.id, lane])), [sortedLanes]);
  const deletingLaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const progress of Object.values(deleteProgressByLaneId)) {
      if (isLaneDeleteProgressActive(progress)) ids.add(progress.laneId);
    }
    return ids;
  }, [deleteProgressByLaneId]);
  const sortedSelectableLaneIds = useMemo(
    () => sortedLanes.map((lane) => lane.id).filter((laneId) => !deletingLaneIds.has(laneId)),
    [sortedLanes, deletingLaneIds],
  );
  // `availableLaneIdsKey` is the content-stable dep trigger (string changes only
  // when the id set changes). `availableLaneIds` recomputes from the key so its
  // identity is also content-stable, letting effects depend on either safely.
  const availableLaneIdsKey = useMemo(
    () => sortedSelectableLaneIds.slice().sort().join("\0"),
    [sortedSelectableLaneIds],
  );
  const availableLaneIds = useMemo(
    () => (availableLaneIdsKey ? availableLaneIdsKey.split("\0") : []),
    [availableLaneIdsKey],
  );
  const integrationSourcesByLaneId = useMemo(
    () => buildIntegrationSourcesByLaneId(integrationProposals, lanesById),
    [integrationProposals, lanesById],
  );
  const lanePrByLaneId = useMemo(() => {
    const map = new Map<string, LaneTabPrTag>();
    for (const lane of sortedLanes) {
      const pr = selectLaneTabPrTag(lane, lanePrTags, laneGithubPrTags);
      if (pr) map.set(lane.id, pr);
    }
    return map;
  }, [sortedLanes, lanePrTags, laneGithubPrTags]);

  const laneRuntimeById = useMemo(() => {
    const summaryByLane = new Map<string, LaneListSnapshot["runtime"]>();
    for (const snapshot of laneSnapshots) {
      summaryByLane.set(snapshot.lane.id, snapshot.runtime);
    }
    for (const lane of sortedLanes) {
      if (!summaryByLane.has(lane.id)) {
        summaryByLane.set(lane.id, {
          bucket: "none",
          runningCount: 0,
          awaitingInputCount: 0,
          endedCount: 0,
          sessionCount: 0,
        });
      }
    }
    return summaryByLane;
  }, [sortedLanes, laneSnapshots]);

  const laneFilterMatchedLanes = useMemo(
    () => sortedLanes.filter((lane) => laneMatchesFilter(lane, pinnedLaneIds.has(lane.id), laneFilter)),
    [sortedLanes, laneFilter, pinnedLaneIds],
  );

  const laneOrderById = useMemo(() => {
    const map = new Map<string, number>();
    sortedLanes.forEach((lane, index) => map.set(lane.id, index));
    return map;
  }, [sortedLanes]);

  useEffect(() => {
    return window.ade.lanes.onEnvEvent((event: LaneEnvInitEvent) => {
      if (event.progress.laneId !== createEnvInitLaneIdRef.current) return;
      setCreateEnvInitProgress(event.progress);
    });
  }, []);

  const filteredLanes = useMemo(() => {
    return sortLaneListRows({
      lanes: laneFilterMatchedLanes,
      laneRuntimeById,
      laneStatusFilter: "all",
      laneOrderById,
      pinnedLaneIds,
    });
  }, [laneFilterMatchedLanes, laneRuntimeById, laneOrderById, pinnedLaneIds]);
  const stackGraphLanes = useMemo(() => sortLanesForStackGraph(filteredLanes), [filteredLanes]);

  const filteredLaneIds = useMemo(() => filteredLanes.map((lane) => lane.id), [filteredLanes]);
  const selectableFilteredLaneIds = useMemo(
    () => filteredLaneIds.filter((laneId) => !deletingLaneIds.has(laneId)),
    [filteredLaneIds, deletingLaneIds],
  );
  const selectableFilteredSet = useMemo(() => new Set(selectableFilteredLaneIds), [selectableFilteredLaneIds]);
  const visibleRebaseSuggestions = useMemo(() => {
    if (suppressTourDistractions) return [];
    const laneIdSet = new Set(selectableFilteredLaneIds);
    return laneSnapshots
      .map((snapshot) => snapshot.rebaseSuggestion)
      .filter(
        (suggestion): suggestion is NonNullable<LaneListSnapshot["rebaseSuggestion"]> => {
          if (suggestion == null) return false;
          return laneIdSet.has(suggestion.laneId);
        },
      );
  }, [laneSnapshots, selectableFilteredLaneIds, suppressTourDistractions]);
  const visibleAutoRebaseNeedsAttention = useMemo(() => {
    if (suppressTourDistractions) return [];
    const laneIdSet = new Set(selectableFilteredLaneIds);
    return laneSnapshots
      .map((snapshot) => snapshot.autoRebaseStatus)
      .filter(
        (status): status is NonNullable<LaneListSnapshot["autoRebaseStatus"]> => {
          if (status == null) return false;
          return laneIdSet.has(status.laneId) && status.state !== "autoRebased";
        },
      );
  }, [laneSnapshots, selectableFilteredLaneIds, suppressTourDistractions]);

  const activeWithPins = useMemo(
    () => mergeUnique(
      activeLaneIds.filter((id) => !deletingLaneIds.has(id)),
      Array.from(pinnedLaneIds).filter((id) => lanesById.has(id) && !deletingLaneIds.has(id)),
    ),
    [activeLaneIds, pinnedLaneIds, lanesById, deletingLaneIds]
  );
  const visibleLaneIds = useMemo(
    () => resolveVisibleLaneIds({
      activeLaneIds: activeWithPins,
      existingLaneIds: lanesById.keys(),
      filteredLaneIds,
      selectableFilteredLaneIds,
      deletingLaneIds,
    }),
    [activeWithPins, lanesById, filteredLaneIds, selectableFilteredLaneIds, deletingLaneIds]
  );

  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi?.setActiveLanePresence) {
      return;
    }
    const laneIds = active && project?.rootPath ? [...visibleLaneIds] : [];
    const signature = laneIds.join("\0");
    if (activeLanePresenceSignatureRef.current === signature) {
      return;
    }
    activeLanePresenceSignatureRef.current = signature;
    void syncApi.setActiveLanePresence({ laneIds }).catch(() => {});
  }, [active, project?.rootPath, visibleLaneIds]);

  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi?.setActiveLanePresence) {
      return;
    }
    return () => {
      if (activeLanePresenceSignatureRef.current === "") {
        return;
      }
      activeLanePresenceSignatureRef.current = "";
      void syncApi.setActiveLanePresence({ laneIds: [] }).catch(() => {});
    };
  }, []);

  const workFocusTiling = useMemo(() => {
    if (params.get("workFocus") !== "1") return false;
    const ids = parseLaneIdsParam(params.get("laneIds"));
    if (ids.length < 2) return false;
    const visibleSet = new Set(visibleLaneIds);
    return ids.every((id) => visibleSet.has(id));
  }, [params, visibleLaneIds]);

  const laneTilingTree = workFocusTiling ? LANES_TILING_WORK_FOCUS_TREE : LANES_TILING_TREE;
  const laneTilingLayoutSuffix = workFocusTiling ? ":wf" : "";

  const managedLane = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
  const managedLanes = useMemo(
    () => managedLaneIds.map((id) => lanesById.get(id)).filter((l): l is LaneSummary => l != null && l.laneType !== "primary"),
    [managedLaneIds, lanesById],
  );
  const isBatchManage = managedLanes.length > 1;
  const deletePhrase = isBatchManage
    ? `delete ${managedLanes.length} lanes`
    : managedLane
      ? `delete ${managedLane.name}`
      : "";
  const selectedAttachedLane = managedLane?.laneType === "attached" ? managedLane : null;
  const shouldShowAdoptHint = Boolean(selectedAttachedLane && !adoptHintDismissed);
  const adoptTargetLane = adoptTargetLaneId ? lanesById.get(adoptTargetLaneId) ?? null : null;

  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);
  const branchLane = useMemo(() => {
    const candidate = selectedLaneId ? lanesById.get(selectedLaneId) ?? primaryLane : primaryLane;
    return candidate ?? null;
  }, [selectedLaneId, lanesById, primaryLane]);
  const branchLaneSwitchDisabledReason = useMemo<string | null>(() => {
    if (!branchLane) return null;
    if (branchLane.laneType === "attached") return "Branch switching is disabled for attached lanes — manage this worktree with your own tools.";
    if (isMissionResultLane(branchLane)) return "Branch switching is disabled for mission result lanes to keep their output stable.";
    if (isMissionLaneHiddenByDefault(branchLane)) return "Branch switching isn't available on mission worker lanes.";
    return null;
  }, [branchLane]);
  const canSwitchBranchLane = branchLane !== null && branchLaneSwitchDisabledReason === null;

  /* ---- Lane branch management ---- */

  useEffect(() => {
    // Always clear stale results when the target lane (or open state) changes
    // — otherwise lane A's branches linger when the user switches to lane B
    // before the new fetch resolves.
    setLaneBranches([]);
    if (!active || !branchLane || !branchDropdownOpen) return;
    let cancelled = false;
    setLaneBranchesLoading(true);
    window.ade.git.listBranches({ laneId: branchLane.id })
      .then((result) => { if (!cancelled) setLaneBranches(result); })
      .catch(() => { if (!cancelled) setLaneBranches([]); })
      .finally(() => { if (!cancelled) setLaneBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [active, branchDropdownOpen, branchLane?.id]);

  useEffect(() => {
    if (!active || !branchLane) return;
    const current = laneBranches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null;
    if (!current || current === branchLane.branchRef) return;
    refreshLanes().catch(() => {});
  }, [active, laneBranches, branchLane?.id, branchLane?.branchRef, refreshLanes]);

  useEffect(() => {
    if (branchDropdownOpen) {
      setBranchSearchQuery("");
      setPendingBranchSwitch(null);
      setNewBranchStartPoint("");
      setNewBranchBaseRef("");
      setNewBranchName("");
      setNewBranchFormOpen(false);
      setTimeout(() => branchSearchInputRef.current?.focus(), 0);
    }
  }, [branchDropdownOpen, branchLane?.id]);
  useClickOutside(branchDropdownRef, () => setBranchDropdownOpen(false), branchDropdownOpen);
  useClickOutside(addLaneDropdownRef, () => setAddLaneDropdownOpen(false), addLaneDropdownOpen);
  useClickOutside(stackGraphHeaderRef, () => setStackGraphHeaderOpen(false), stackGraphHeaderOpen);

  const refreshAutoRebaseEnabled = useCallback(async () => {
    try {
      const snapshot = await getProjectConfigCached({ projectRoot: project?.rootPath ?? null });
      const enabled =
        typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean"
          ? snapshot.effective.git.autoRebaseOnHeadChange
          : false;
      setAutoRebaseEnabled(enabled);
    } catch {
      setAutoRebaseEnabled(false);
    }
  }, [project?.rootPath]);

  const refreshIntegrationProposals = useCallback(async () => {
    try {
      const proposals = await window.ade.prs.listProposals();
      setIntegrationProposals(proposals);
    } catch {
      setIntegrationProposals([]);
    }
  }, []);

  const refreshLanePrTags = useCallback(async () => {
    const requestId = ++lanePrTagsRequestRef.current;
    const startedRoot = appStore.getState().project?.rootPath ?? null;
    try {
      const prs = await window.ade.prs.listAll();
      if (requestId !== lanePrTagsRequestRef.current) return;
      if ((appStore.getState().project?.rootPath ?? null) !== startedRoot) return;
      setLanePrTags(prs);
    } catch {
      if (requestId !== lanePrTagsRequestRef.current) return;
      if ((appStore.getState().project?.rootPath ?? null) !== startedRoot) return;
      setLanePrTags([]);
    }
  }, [appStore]);

  const refreshLaneGithubPrTags = useCallback(async (options?: { force?: boolean }) => {
    const requestId = ++laneGithubPrTagsRequestRef.current;
    const startedRoot = appStore.getState().project?.rootPath ?? null;
    try {
      const snapshot = await window.ade.prs.getGitHubSnapshot({ force: options?.force === true });
      if (requestId !== laneGithubPrTagsRequestRef.current) return;
      if ((appStore.getState().project?.rootPath ?? null) !== startedRoot) return;
      setLaneGithubPrTags(snapshot.repoPullRequests);
    } catch {
      if (requestId !== laneGithubPrTagsRequestRef.current) return;
      if ((appStore.getState().project?.rootPath ?? null) !== startedRoot) return;
      // Keep the last usable GitHub snapshot visible on transient refresh failures.
    }
  }, [appStore]);

  const scheduleLaneDeleteRefresh = useCallback(() => {
    if (laneDeleteRefreshTimerRef.current != null) return;
    laneDeleteRefreshTimerRef.current = window.setTimeout(() => {
      laneDeleteRefreshTimerRef.current = null;
      const laneIds = Array.from(pendingLaneDeleteRefreshIdsRef.current);
      pendingLaneDeleteRefreshIdsRef.current.clear();
      if (laneIds.length === 0) return;

      void refreshLanes({ includeStatus: false })
        .then(() => {
          const selectedId = selectedLaneIdRef.current;
          const managedIds = managedLaneIdsRef.current;
          if (manageOpenRef.current && laneIds.some((laneId) => selectedId === laneId || managedIds.includes(laneId))) {
            setManageOpen(false);
          }
        })
        .catch((err) => {
          setLaneActionError(`Lane was deleted, but refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, LANE_DELETE_REFRESH_DEBOUNCE_MS);
  }, [refreshLanes]);

  const queueLaneDeleteRefresh = useCallback((laneIds: string[]) => {
    for (const laneId of laneIds) {
      if (laneId) pendingLaneDeleteRefreshIdsRef.current.add(laneId);
    }
    if (pendingLaneDeleteRefreshIdsRef.current.size > 0) {
      scheduleLaneDeleteRefresh();
    }
  }, [scheduleLaneDeleteRefresh]);

  /* ---- Effects ---- */

  // Mirror high-churn values into refs so the IPC subscription below doesn't
  // re-subscribe every render (lanesById is rebuilt whenever any lane field
  // changes; selectedLaneId / managedLaneIds / manageOpen flip on every nav).
  useEffect(() => { selectedLaneIdRef.current = selectedLaneId; }, [selectedLaneId]);
  useEffect(() => { lanesByIdRef.current = lanesById; }, [lanesById]);
  useEffect(() => { managedLaneIdsRef.current = managedLaneIds; }, [managedLaneIds]);
  useEffect(() => { manageOpenRef.current = manageOpen; }, [manageOpen]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.onDeleteEvent((event) => {
      const { laneId, overallStatus } = event.progress;
      setDeleteProgressByLaneId((prev) => {
        if (isLaneDeleteProgressActive(event.progress)) {
          return { ...prev, [laneId]: event.progress };
        }
        if (!prev[laneId]) return prev;
        const next = { ...prev };
        delete next[laneId];
        return next;
      });
      if (overallStatus === "failed" || overallStatus === "cancelled") {
        laneDeleteWarningMessagesRef.current.delete(laneId);
        completedLaneDeleteRefreshesRef.current.delete(laneId);
        const laneName = lanesByIdRef.current?.get(laneId)?.name ?? laneId;
        setLaneActionError(
          overallStatus === "cancelled"
            ? `${laneName} delete was cancelled.`
            : formatLaneDeleteProgressError(event.progress, laneName),
        );
        return;
      }
      if (overallStatus !== "completed" && overallStatus !== "completed_with_warnings") return;
      if (completedLaneDeleteRefreshesRef.current.has(laneId)) return;
      completedLaneDeleteRefreshesRef.current.add(laneId);

      if (selectedLaneIdRef.current === laneId) selectLane(null);
      setActiveLaneIds((prev) => prev.filter((id) => id !== laneId));
      setPinnedLaneIds((prev) => {
        if (!prev.has(laneId)) return prev;
        const next = new Set(prev);
        next.delete(laneId);
        return next;
      });
      setManagedLaneIds((prev) => prev.filter((id) => id !== laneId));
      clearLaneInspectorTab(laneId);
      if (overallStatus === "completed_with_warnings") {
        const laneName = lanesByIdRef.current?.get(laneId)?.name ?? laneId;
        laneDeleteWarningMessagesRef.current.set(laneId, formatLaneDeleteProgressError(event.progress, laneName));
        setLaneActionError(formatLaneDeleteWarningMessages(laneDeleteWarningMessagesRef.current));
      } else {
        laneDeleteWarningMessagesRef.current.delete(laneId);
        const remainingWarnings = formatLaneDeleteWarningMessages(laneDeleteWarningMessagesRef.current);
        setLaneActionError((current) => remainingWarnings ?? (current && /\bdelet(?:e|ed|ing)\b/i.test(current) ? null : current));
      }
      queueLaneDeleteRefresh([laneId]);
    });
    return unsubscribe;
  }, [active, clearLaneInspectorTab, queueLaneDeleteRefresh, selectLane, setDeleteProgressByLaneId]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.onRebaseSuggestionsEvent((event) => {
      if (event.type !== "rebase-suggestions-updated") return;
      void refreshLanes().catch(() => {});
    });
    return unsubscribe;
  }, [active, refreshLanes]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      void refreshLanes().catch(() => {});
    });
    return unsubscribe;
  }, [active, refreshLanes]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.rebaseSubscribe((event) => {
      if (event.type !== "rebase-run-updated") return;
      if (event.run.state !== "failed" || !event.run.failedLaneId) return;
      const failedLane = lanesById.get(event.run.failedLaneId)?.name ?? event.run.failedLaneId;
      setRebaseSuggestionError(`Rebase needs attention for ${failedLane}. ${event.run.error ?? ""}`.trim());
    });
    return unsubscribe;
  }, [active, lanesById]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      void refreshAutoRebaseEnabled();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [active, refreshAutoRebaseEnabled]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      void refreshIntegrationProposals();
    }, 140);
    return () => window.clearTimeout(timer);
  }, [active, refreshIntegrationProposals, project?.rootPath]);

  useEffect(() => {
    lanePrTagsRequestRef.current += 1;
    laneGithubPrTagsRequestRef.current += 1;
    setLanePrTags([]);
    setLaneGithubPrTags([]);
    if (!active || !project?.rootPath) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refreshLanePrTags();
      void refreshLaneGithubPrTags({ force: true });
    }, 160);
    return () => {
      lanePrTagsRequestRef.current += 1;
      laneGithubPrTagsRequestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [active, refreshLanePrTags, refreshLaneGithubPrTags, project?.rootPath, lanePrBranchSignature]);

  useEffect(() => {
    if (!active) return;
    return window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") {
        lanePrTagsRequestRef.current += 1;
        setLanePrTags(event.prs);
        // This event already carries ADE rows; use the cached repo snapshot unless a PR notification asks for a forced refresh.
        void refreshLaneGithubPrTags();
      } else if (event.type === "pr-notification") {
        void refreshLanePrTags();
        void refreshLaneGithubPrTags({ force: true });
      }
    });
  }, [active, refreshLanePrTags, refreshLaneGithubPrTags]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshRuntimeOnly = () =>
      refreshLanes({
        includeStatus: false,
        includeSnapshots: true,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });
    const scheduleRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) return; // already scheduled
      timer = setTimeout(() => {
        timer = null;
        void refreshRuntimeOnly().catch(() => {});
      }, 300);
    };
    const currentProjectRoot = project?.rootPath ?? null;
    const isCurrentProjectEvent = (event: { projectRoot?: string | null }) =>
      !event.projectRoot || event.projectRoot === currentProjectRoot;
    const unsubPtyData = window.ade.pty.onData((event) => {
      if (isCurrentProjectEvent(event)) scheduleRefresh();
    });
    const unsubPtyExit = window.ade.pty.onExit((event) => {
      if (isCurrentProjectEvent(event)) scheduleRefresh();
    });
    const unsubChat = window.ade.agentChat.onEvent(scheduleRefresh);
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasActiveLaneRuntimeRef.current) return;
      void refreshRuntimeOnly().catch(() => {});
    }, 15_000);
    return () => {
      if (timer) clearTimeout(timer);
      try {
        unsubPtyData();
      } catch {
        // ignore
      }
      try {
        unsubPtyExit();
      } catch {
        // ignore
      }
      try {
        unsubChat();
      } catch {
        // ignore
      }
      window.clearInterval(intervalId);
    };
  }, [active, project?.rootPath, refreshLanes]);

  useEffect(() => {
    hasActiveLaneRuntimeRef.current = laneSnapshots.some((snapshot) =>
      snapshot.runtime.bucket === "running" || snapshot.runtime.bucket === "awaiting-input",
    );
  }, [laneSnapshots]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => { void refreshAutoRebaseEnabled(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshAutoRebaseEnabled();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, refreshAutoRebaseEnabled]);

  useEffect(() => {
    const pendingLaneDeleteRefreshIds = pendingLaneDeleteRefreshIdsRef.current;
    return () => {
      if (laneDeleteRefreshTimerRef.current != null) {
        window.clearTimeout(laneDeleteRefreshTimerRef.current);
        laneDeleteRefreshTimerRef.current = null;
      }
      pendingLaneDeleteRefreshIds.clear();
    };
  }, []);

  useEffect(() => {
    if (!laneContextMenu) return;
    const onPointerDown = () => setLaneContextMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [laneContextMenu]);

  useEffect(() => {
    if (!adoptTargetLaneId) return;
    if (lanesById.has(adoptTargetLaneId)) return;
    setAdoptConfirmOpen(false);
    setAdoptTargetLaneId(null);
    setAdoptError(null);
  }, [adoptTargetLaneId, lanesById]);

  useEffect(() => {
    setPinnedLaneIds((prev) => {
      const next = new Set<string>();
      for (const laneId of prev) {
        if (lanesById.has(laneId)) next.add(laneId);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [lanesById]);

  useEffect(() => {
    setDeleteProgressByLaneId((prev) => {
      const next: Record<string, LaneDeleteProgress> = {};
      for (const [laneId, progress] of Object.entries(prev)) {
        if (lanesById.has(laneId) && isLaneDeleteProgressActive(progress)) next[laneId] = progress;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [lanesById, setDeleteProgressByLaneId]);

  useEffect(() => {
    const pinned = Array.from(pinnedLaneIds).filter((laneId) => lanesById.has(laneId) && !deletingLaneIds.has(laneId));
    setActiveLaneIds((prev) => {
      const validPrev = prev.filter((laneId) => lanesById.has(laneId) && !deletingLaneIds.has(laneId));
      const selected = selectedLaneId && lanesById.has(selectedLaneId) && !deletingLaneIds.has(selectedLaneId) ? [selectedLaneId] : [];
      const fallback = selected.length
        ? []
        : validPrev.length
          ? [validPrev[0]!]
          : sortedSelectableLaneIds[0]
            ? [sortedSelectableLaneIds[0]]
            : [];
      return mergeUnique(selected, fallback, validPrev, pinned);
    });
  }, [selectedLaneId, lanesById, sortedSelectableLaneIds, pinnedLaneIds, deletingLaneIds]);

  useEffect(() => {
    setLanePaneDetails((prev) => {
      const next: Record<string, LanePaneDetailSelection> = {};
      for (const [laneId, detail] of Object.entries(prev)) {
        if (lanesById.has(laneId)) next[laneId] = detail;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [lanesById]);

  /* ---- Keyboard navigation ---- */

  const stepLaneSelection = useCallback((direction: -1 | 1) => {
    if (selectableFilteredLaneIds.length === 0) return;
    const currentId = selectedLaneId && selectableFilteredSet.has(selectedLaneId) ? selectedLaneId : selectableFilteredLaneIds[0]!;
    const currentIdx = selectableFilteredLaneIds.indexOf(currentId);
    const nextIdx = (currentIdx + direction + selectableFilteredLaneIds.length) % selectableFilteredLaneIds.length;
    const nextId = selectableFilteredLaneIds[nextIdx];
    if (!nextId) return;
    const pinned = Array.from(pinnedLaneIds).filter((laneId) => laneId !== nextId && lanesById.has(laneId) && !deletingLaneIds.has(laneId));
    setActiveLaneIds(mergeUnique([nextId], pinned));
    selectLane(nextId);
  }, [selectableFilteredLaneIds, selectedLaneId, selectableFilteredSet, pinnedLaneIds, lanesById, deletingLaneIds, selectLane]);

  const kbFilterFocus = useMemo(() => getEffectiveBinding(keybindings, "lanes.filter.focus", "/,Mod+F"), [keybindings]);
  const kbNext = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.next", "J,ArrowDown"), [keybindings]);
  const kbPrev = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prev", "K,ArrowUp"), [keybindings]);
  const kbNextTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.nextTab", "]"), [keybindings]);
  const kbPrevTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prevTab", "["), [keybindings]);
  const kbConfirm = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.confirm", "Enter"), [keybindings]);

  useEffect(() => {
    if (expandedGitActionsLaneId && !lanesById.has(expandedGitActionsLaneId)) {
      setExpandedGitActionsLaneId(null);
    }
    if (expandedGitActionsLaneId && deletingLaneIds.has(expandedGitActionsLaneId)) {
      setExpandedGitActionsLaneId(null);
    }
  }, [expandedGitActionsLaneId, lanesById, deletingLaneIds]);

  useEffect(() => {
    if (expandedLaneId && (!lanesById.has(expandedLaneId) || deletingLaneIds.has(expandedLaneId))) {
      setExpandedLaneId(null);
    }
  }, [expandedLaneId, lanesById, deletingLaneIds]);

  useEffect(() => {
    if (!selectedLaneId || !deletingLaneIds.has(selectedLaneId)) return;
    selectLane(selectableFilteredLaneIds[0] ?? sortedSelectableLaneIds[0] ?? null);
  }, [selectedLaneId, deletingLaneIds, selectableFilteredLaneIds, sortedSelectableLaneIds, selectLane]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const targetIsTyping = isTypingTarget(event.target);
      if (!targetIsTyping && eventMatchesBinding(event, kbFilterFocus)) {
        event.preventDefault();
        const input = document.getElementById("lanes-filter-input");
        if (input instanceof HTMLInputElement) { input.focus(); input.select(); }
        return;
      }
      if (event.key === "Escape" && expandedGitActionsLaneId) {
        event.preventDefault();
        setExpandedGitActionsLaneId(null);
        return;
      }
      if (event.key === "Escape" && expandedLaneId) {
        event.preventDefault();
        setExpandedLaneId(null);
        return;
      }
      if (targetIsTyping) {
        if (event.key === "Escape") {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active.id === "lanes-filter-input") {
            event.preventDefault();
            if (laneFilter.length > 0) setLaneFilter("");
            else active.blur();
          }
        }
        return;
      }
      if (eventMatchesBinding(event, kbPrevTab) || eventMatchesBinding(event, kbNextTab)) {
        event.preventDefault();
        stepLaneSelection(eventMatchesBinding(event, kbNextTab) ? 1 : -1);
        return;
      }
      if (eventMatchesBinding(event, kbNext)) { event.preventDefault(); stepLaneSelection(1); return; }
      if (eventMatchesBinding(event, kbPrev)) { event.preventDefault(); stepLaneSelection(-1); return; }
      if (eventMatchesBinding(event, kbConfirm) && selectableFilteredLaneIds.length > 0) {
        event.preventDefault();
        const laneId = selectedLaneId && selectableFilteredSet.has(selectedLaneId) ? selectedLaneId : selectableFilteredLaneIds[0]!;
        const pinned = Array.from(pinnedLaneIds).filter((lane) => lane !== laneId && lanesById.has(lane) && !deletingLaneIds.has(lane));
        setActiveLaneIds(mergeUnique([laneId], pinned));
        selectLane(laneId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectableFilteredLaneIds, selectableFilteredSet, selectedLaneId, pinnedLaneIds, lanesById, deletingLaneIds, selectLane, laneFilter, stepLaneSelection, kbFilterFocus, kbNext, kbPrev, kbNextTab, kbPrevTab, kbConfirm, expandedLaneId, expandedGitActionsLaneId]);

  /* ---- Lane management actions ---- */

  const currentLaneBranch = useMemo(
    () => laneBranches.find((branch) => branch.isCurrent)?.name ?? branchLane?.branchRef ?? "",
    [laneBranches, branchLane?.branchRef]
  );
  const localLaneBranches = useMemo(() => {
    const q = branchSearchQuery.toLowerCase();
    return laneBranches.filter((branch) => !branch.isRemote && (!q || branch.name.toLowerCase().includes(q)));
  }, [laneBranches, branchSearchQuery]);
  const remoteLaneBranches = useMemo(() => {
    const q = branchSearchQuery.toLowerCase();
    return laneBranches.filter((branch) => branch.isRemote && (!q || branch.name.toLowerCase().includes(q)));
  }, [laneBranches, branchSearchQuery]);
  const startPointOptions = useMemo(() => {
    type StartOption = { value: string; label: string; group: "lane" | "local" | "remote" };
    const map = new Map<string, StartOption>();
    if (branchLane?.branchRef) {
      map.set(branchLane.branchRef, { value: branchLane.branchRef, label: branchLane.branchRef, group: "lane" });
    }
    for (const branch of laneBranches) {
      if (branch.isRemote) continue;
      if (!map.has(branch.name)) map.set(branch.name, { value: branch.name, label: branch.name, group: "local" });
    }
    for (const branch of laneBranches) {
      if (!branch.isRemote) continue;
      const local = stripRemotePrefix(branch.name);
      if (map.has(local)) continue;
      if (!map.has(branch.name)) {
        map.set(branch.name, { value: branch.name, label: `${branch.name} (remote)`, group: "remote" });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [branchLane?.branchRef, laneBranches]);
  const baseRefOptions = useMemo(() => {
    const names = new Set<string>();
    if (primaryLane?.branchRef) names.add(primaryLane.branchRef);
    for (const opt of startPointOptions) names.add(opt.value);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [startPointOptions, primaryLane?.branchRef]);
  const branchNameValidation = useMemo(
    () => (newBranchName.trim() ? validateBranchName(newBranchName) : { ok: false }),
    [newBranchName],
  );

  const runLaneAction = async (
    fn: () => Promise<void>,
    status: string,
    kind: "delete" | "archive" | "adopt" = "delete",
    options: { refreshAfter?: boolean } = {},
  ) => {
    setLaneActionBusy(true);
    setLaneActionKind(kind);
    setLaneActionStatus(status);
    setLaneActionError(null);
    try {
      await fn();
      if (options.refreshAfter !== false) {
        await refreshLanes();
      }
      setManageOpen(false);
    } catch (err) {
      setLaneActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  };

  const dismissAdoptHint = useCallback(() => {
    setAdoptHintDismissed(true);
    try {
      window.localStorage.setItem(ADOPT_HINT_DISMISSED_KEY, "1");
    } catch {
      // ignore persistence failures
    }
  }, []);

  const reopenAdoptHint = useCallback(() => {
    setAdoptHintDismissed(false);
    try {
      window.localStorage.removeItem(ADOPT_HINT_DISMISSED_KEY);
    } catch {
      // ignore persistence failures
    }
  }, []);

  const requestAdoptAttachedLane = useCallback((laneId: string) => {
    setAdoptError(null);
    setAdoptTargetLaneId(laneId);
    setAdoptConfirmOpen(true);
  }, []);

  const confirmAdoptAttachedLane = useCallback(async () => {
    const laneId = adoptTargetLaneId;
    if (!laneId) return;
    setAdoptBusy(true);
    setAdoptError(null);
    try {
      const lane = await window.ade.lanes.adoptAttached({ laneId });
      await refreshLanes();
      selectLane(lane.id);
      setAdoptConfirmOpen(false);
      setAdoptTargetLaneId(null);
    } catch (err) {
      setAdoptError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdoptBusy(false);
    }
  }, [adoptTargetLaneId, refreshLanes, selectLane]);

  const checkoutLaneBranch = useCallback(async (request: {
    branchName: string;
    mode?: "existing" | "create";
    startPoint?: string;
    baseRef?: string;
    acknowledgeActiveWork?: boolean;
  }) => {
    if (!branchLane) return;
    if (branchLane.status.dirty) {
      setBranchCheckoutError(`Cannot switch branches while ${branchLane.name} has uncommitted changes. Commit, stash, or discard changes first.`);
      return;
    }
    const mode = request.mode ?? "existing";
    const branchName = request.branchName.trim();
    if (!branchName) return;
    setBranchCheckoutBusy(true);
    setBranchCheckoutError(null);
    let succeeded = false;
    try {
      if (!request.acknowledgeActiveWork) {
        const preview = await window.ade.lanes.previewBranchSwitch({
          laneId: branchLane.id,
          branchName,
          mode,
          startPoint: request.startPoint,
          baseRef: request.baseRef,
        });
        if (preview.duplicateLaneId) {
          throw new Error(`Branch '${preview.targetBranchRef}' is already active in ${preview.duplicateLaneName ?? "another lane"}.`);
        }
        if (preview.dirty) {
          throw new Error(`Cannot switch branches while ${branchLane.name} has uncommitted changes.`);
        }
        if (preview.activeWork.length > 0) {
          setPendingBranchSwitch({
            branchName,
            mode,
            startPoint: request.startPoint,
            baseRef: request.baseRef,
            activeWork: preview.activeWork,
          });
          return;
        }
      }
      await window.ade.git.checkoutBranch({
        laneId: branchLane.id,
        branchName,
        mode,
        startPoint: request.startPoint,
        baseRef: request.baseRef,
        acknowledgeActiveWork: request.acknowledgeActiveWork,
      });
      await refreshLanes();
      const updated = await window.ade.git.listBranches({ laneId: branchLane.id });
      setLaneBranches(updated);
      setPendingBranchSwitch(null);
      setNewBranchName("");
      succeeded = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setBranchCheckoutError(formatBranchCheckoutError(raw, branchLane.name));
    } finally {
      setBranchCheckoutBusy(false);
      if (succeeded) setBranchDropdownOpen(false);
    }
  }, [branchLane, refreshLanes]);

  const archiveManagedLanes = async () => {
    const targets = isBatchManage ? managedLanes : managedLane ? [managedLane] : [];
    const actionable = targets.filter((l) => l.laneType !== "primary");
    if (actionable.length === 0) return;
    await runLaneAction(async () => {
      for (const lane of actionable) {
        await window.ade.lanes.archive({ laneId: lane.id });
      }
    }, actionable.length > 1 ? `Archiving ${actionable.length} lanes...` : "Archiving lane...", "archive");
  };

  const moveAwayFromDeletingLanes = useCallback((laneIds: string[]) => {
    const allDeletingLaneIds = new Set([...deletingLaneIds, ...laneIds]);
    const selection = resolveLaneDeleteStartSelection({
      deletingLaneIds: allDeletingLaneIds,
      selectedLaneId,
      activeLaneIds,
      pinnedLaneIds,
      filteredLaneIds,
      sortedLaneIds: sortedSelectableLaneIds,
    });
    setPinnedLaneIds(selection.pinnedLaneIds);
    setActiveLaneIds(selection.activeLaneIds);
    selectLane(selection.selectedLaneId);
    for (const laneId of laneIds) {
      clearLaneInspectorTab(laneId);
    }
    const nextSearch = selection.selectedLaneId
      ? `?laneId=${encodeURIComponent(selection.selectedLaneId)}`
      : "";
    navigate(`/lanes${nextSearch}`, { replace: true });
  }, [
    activeLaneIds,
    clearLaneInspectorTab,
    deletingLaneIds,
    filteredLaneIds,
    navigate,
    pinnedLaneIds,
    selectLane,
    selectedLaneId,
    sortedSelectableLaneIds,
  ]);

  useEffect(() => {
    const projectRoot = project?.rootPath ?? null;
    if (!projectRoot) return;
    if (hydratedLaneDeleteProgressProjectRef.current === projectRoot) return;
    hydratedLaneDeleteProgressProjectRef.current = projectRoot;
    let cancelled = false;
    const getStoredActiveLaneIds = () => Object.values(appStore.getState().laneDeleteProgressByLaneId)
      .filter(isLaneDeleteProgressActive)
      .map((progress) => progress.laneId);
    const recoverStoredActiveLaneDeletes = () => {
      const storedActiveLaneIds = getStoredActiveLaneIds();
      if (storedActiveLaneIds.length === 0) return;
      moveAwayFromDeletingLanes(storedActiveLaneIds);
      queueLaneDeleteRefresh(storedActiveLaneIds);
    };
    if (!window.ade.lanes.listDeleteProgress) {
      recoverStoredActiveLaneDeletes();
      return;
    }
    void window.ade.lanes.listDeleteProgress()
      .then((progresses) => {
        if (cancelled) return;
        const activeProgresses = (Array.isArray(progresses) ? progresses : []).filter(isLaneDeleteProgressActive);
        const activeProgressLaneIds = new Set(activeProgresses.map((progress) => progress.laneId));
        const storedActiveLaneIds = getStoredActiveLaneIds();
        const laneIdsWithoutBackendProgress = storedActiveLaneIds.filter((laneId) => !activeProgressLaneIds.has(laneId));
        const laneIds = mergeUnique(
          activeProgresses.map((progress) => progress.laneId),
          laneIdsWithoutBackendProgress,
        );
        if (laneIds.length === 0) return;
        if (activeProgresses.length > 0) {
          setDeleteProgressByLaneId((prev) => {
            const next = { ...prev };
            for (const progress of activeProgresses) {
              next[progress.laneId] = progress;
            }
            return next;
          });
        }
        moveAwayFromDeletingLanes(laneIds);
        const refreshLaneIds = [...laneIdsWithoutBackendProgress];
        for (const progress of activeProgresses) {
          if (progress.overallStatus !== "completed" && progress.overallStatus !== "completed_with_warnings") continue;
          if (completedLaneDeleteRefreshesRef.current.has(progress.laneId)) continue;
          completedLaneDeleteRefreshesRef.current.add(progress.laneId);
          refreshLaneIds.push(progress.laneId);
        }
        queueLaneDeleteRefresh(refreshLaneIds);
      })
      .catch((error) => {
        if (cancelled) return;
        recoverStoredActiveLaneDeletes();
        console.debug("Failed to hydrate lane delete progress:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [active, appStore, project?.rootPath, moveAwayFromDeletingLanes, queueLaneDeleteRefresh, setDeleteProgressByLaneId]);

  const deleteManagedLanes = async () => {
    const targets = isBatchManage ? managedLanes : managedLane ? [managedLane] : [];
    const actionable = targets.filter((l) => l.laneType !== "primary");
    if (actionable.length === 0) return;
    if (deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()) return;

    const deleteArgsByLaneId = new Map<string, DeleteLaneArgs>();
    for (const lane of actionable) {
      const args: DeleteLaneArgs = { laneId: lane.id, force: deleteForce };
      if (deleteMode === "worktree") {
        args.deleteBranch = false;
      } else {
        args.deleteBranch = true;
        if (deleteMode === "remote_branch") {
          args.deleteRemoteBranch = true;
          args.remoteName = deleteRemoteName.trim() || "origin";
        }
      }
      deleteArgsByLaneId.set(lane.id, args);
    }

    const laneIds = actionable.map((lane) => lane.id);
    completedLaneDeleteRefreshesRef.current = new Set(
      Array.from(completedLaneDeleteRefreshesRef.current).filter((laneId) => !laneIds.includes(laneId)),
    );
    setDeleteProgressByLaneId((prev) => {
      const next = { ...prev };
      for (const laneId of laneIds) {
        next[laneId] = createPendingDeleteProgress(laneId);
      }
      return next;
    });
    setManageOpen(false);
    setLaneActionBusy(false);
    setLaneActionStatus(null);
    setLaneActionKind(null);
    laneDeleteWarningMessagesRef.current.clear();
    setLaneActionError(null);
    setDeleteConfirmText("");
    moveAwayFromDeletingLanes(laneIds);

    void (async () => {
      const errors: string[] = [];
      const blockedLaneIds = new Set<string>();
      const hasBlockedSelectedDescendant = (laneId: string): boolean => {
        for (const blockedLaneId of blockedLaneIds) {
          if (laneHasAncestor(blockedLaneId, laneId, lanesById)) return true;
        }
        return false;
      };

      for (const batch of planLaneDeleteBatches(actionable)) {
        const runnable = batch.filter((lane) => {
          if (!hasBlockedSelectedDescendant(lane.id)) return true;
          blockedLaneIds.add(lane.id);
          errors.push(`${lane.name}: skipped because a selected child lane did not delete.`);
          setDeleteProgressByLaneId((prev) => {
            const next = { ...prev };
            delete next[lane.id];
            return next;
          });
          return false;
        });
        if (runnable.length === 0) continue;

        const results = await runLaneDeleteBatchSequentially(
          runnable,
          async (lane) => {
            const args = deleteArgsByLaneId.get(lane.id);
            if (!args) return;
            await window.ade.lanes.delete(args);
          },
        );
        results.forEach((result) => {
          if (result.status === "fulfilled") return;
          const lane = result.lane;
          blockedLaneIds.add(lane.id);
          errors.push(`${lane.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          setDeleteProgressByLaneId((prev) => {
            const next = { ...prev };
            delete next[lane.id];
            return next;
          });
        });
      }
      if (errors.length > 0) {
        setLaneActionError(errors.join("\n"));
      }
    })();
  };

  const openBatchManage = useCallback((laneIds: string[]) => {
    const manageable = laneIds.filter((id) => {
      const lane = lanesById.get(id);
      return lane && lane.laneType !== "primary" && !deletingLaneIds.has(id);
    });
    if (manageable.length === 0) return;
    setManagedLaneIds(manageable);
    setLaneActionError(null);
    setDeleteForce(false);
    setDeleteMode("worktree");
    setDeleteRemoteName("origin");
    setDeleteConfirmText("");
    setManageOpen(true);
  }, [lanesById, deletingLaneIds]);

  const handleLaneSelect = useCallback((laneId: string, args: { extend: boolean }) => {
    if (deletingLaneIds.has(laneId)) return;
    const lane = lanesById.get(laneId);
    if (!lane) return;

    if (!args.extend) {
      const pinned = Array.from(pinnedLaneIds).filter((id) => id !== laneId && lanesById.has(id) && !deletingLaneIds.has(id));
      setActiveLaneIds(mergeUnique([laneId], pinned));
      selectLane(laneId);
      return;
    }

    const isPinned = pinnedLaneIds.has(laneId);
    const isActive = activeWithPins.includes(laneId);
    if (isPinned && isActive) {
      selectLane(laneId);
      return;
    }

    const next = isActive ? activeWithPins.filter((id) => id !== laneId) : [...activeWithPins, laneId];
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id) && !deletingLaneIds.has(id));
    setActiveLaneIds(mergeUnique(next.length ? next : [laneId], pinned));
    selectLane(laneId);
  }, [deletingLaneIds, lanesById, pinnedLaneIds, activeWithPins, selectLane]);

  const handleStartChatWithLinearIssue = useCallback((laneId: string, issue: LaneLinearIssue) => {
    if (deletingLaneIds.has(laneId) || !lanesById.has(laneId)) return;
    const pinned = Array.from(pinnedLaneIds).filter((id) => id !== laneId && lanesById.has(id) && !deletingLaneIds.has(id));
    setActiveLaneIds(mergeUnique([laneId], pinned));
    selectLane(laneId);
    setStackGraphHeaderOpen(false);
    setLaneWorkViewState(project?.rootPath ?? null, laneId, (prev) => ({
      ...prev,
      draftKind: "chat",
      viewMode: "tabs",
      activeItemId: null,
      selectedItemId: null,
    }));
    setLinearIssueChatContextRequest({
      laneId,
      issue,
      requestedAt: Date.now(),
    });
    navigate(`/lanes?laneId=${encodeURIComponent(laneId)}`);
  }, [deletingLaneIds, lanesById, navigate, pinnedLaneIds, project?.rootPath, selectLane, setLaneWorkViewState]);

  const removeSplitLane = useCallback((laneId: string) => {
    if (pinnedLaneIds.has(laneId)) return;
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id) && !deletingLaneIds.has(id));
    const next = activeWithPins.filter((id) => id !== laneId);
    const normalized = mergeUnique(next, pinned);
    setActiveLaneIds(normalized);
    if (!normalized.includes(selectedLaneId ?? "")) {
      selectLane(normalized[0] ?? null);
    }
  }, [pinnedLaneIds, lanesById, deletingLaneIds, activeWithPins, selectedLaneId, selectLane]);

  const togglePinnedLane = useCallback((laneId: string) => {
    const lane = lanesById.get(laneId);
    if (!lane || lane.laneType === "primary" || deletingLaneIds.has(laneId)) return;
    const isPinned = pinnedLaneIds.has(laneId);
    setPinnedLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
    if (!isPinned) {
      setActiveLaneIds((prev) => mergeUnique(prev, [laneId]));
    }
  }, [lanesById, deletingLaneIds, pinnedLaneIds]);

  const resetGridLayout = useCallback(async (preferredLaneId?: string | null) => {
    const selectedVisibleLane =
      preferredLaneId && lanesById.has(preferredLaneId) && !deletingLaneIds.has(preferredLaneId)
        ? preferredLaneId
        : selectedLaneId && lanesById.has(selectedLaneId) && !deletingLaneIds.has(selectedLaneId)
          ? selectedLaneId
          : visibleLaneIds[0] ?? selectableFilteredLaneIds[0] ?? sortedSelectableLaneIds[0] ?? null;
    if (selectedVisibleLane) {
      setPinnedLaneIds(new Set());
      setActiveLaneIds([selectedVisibleLane]);
      selectLane(selectedVisibleLane);
    }
    const promises: Promise<void>[] = [];
    const laneIdsToReset = new Set<string>([
      ...selectableFilteredLaneIds,
      ...visibleLaneIds,
      ...activeLaneIds,
    ]);
    if (selectedVisibleLane) laneIdsToReset.add(selectedVisibleLane);
    for (const laneId of laneIdsToReset) {
      for (const layoutKey of laneTilingLayoutIds(laneId)) {
        promises.push(
          window.ade.layout.set(layoutKey, {}).catch(() => {}),
          window.ade.tilingTree.set(layoutKey, {}).catch(() => {})
        );
      }
    }
    /* Also reset lane column widths */
    promises.push(window.ade.layout.set("lanes:columns:v1", {}).catch(() => {}));
    await Promise.all(promises);
    /* Force full remount so default sizes/trees take effect */
    setGridResetKey((k) => k + 1);
  }, [activeLaneIds, selectableFilteredLaneIds, lanesById, deletingLaneIds, selectLane, selectedLaneId, sortedSelectableLaneIds, visibleLaneIds]);

  useEffect(() => {
    const onTourEnded = (event: Event) => {
      const detail = (event as CustomEvent<{ tourId?: unknown }>).detail;
      if (detail?.tourId !== "first-journey") return;
      void resetGridLayout(selectedLaneId);
    };
    window.addEventListener("ade:tour-ended", onTourEnded);
    return () => window.removeEventListener("ade:tour-ended", onTourEnded);
  }, [resetGridLayout, selectedLaneId]);

  useEffect(() => {
    const onTourFocusLane = (event: Event) => {
      const detail = (event as CustomEvent<{ laneId?: unknown }>).detail;
      const requestedLaneId = typeof detail?.laneId === "string" ? detail.laneId : null;
      const requestedLane = requestedLaneId ? lanesById.get(requestedLaneId) ?? null : null;
      const selectedLane = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
      const fallbackLane =
        selectedLane && selectedLane.laneType !== "primary"
          ? selectedLane
          : sortedLanes.find((lane) => lane.laneType !== "primary") ?? null;
      const targetLane = requestedLane && requestedLane.laneType !== "primary" ? requestedLane : fallbackLane;
      if (!targetLane) return;
      setActiveLaneIds([targetLane.id]);
      selectLane(targetLane.id);
      void Promise.all([
        ...laneTilingLayoutIds(targetLane.id).flatMap((layoutKey) => [
          window.ade.layout.set(layoutKey, {}).catch(() => {}),
          window.ade.tilingTree.set(layoutKey, {}).catch(() => {}),
        ]),
        window.ade.layout.set("lanes:columns:v1", {}).catch(() => {}),
      ]).finally(() => setGridResetKey((k) => k + 1));
    };
    window.addEventListener("ade:tour-focus-lane", onTourFocusLane);
    return () => window.removeEventListener("ade:tour-focus-lane", onTourFocusLane);
  }, [lanesById, selectLane, selectedLaneId, sortedLanes]);

  const requestRebaseScope = useCallback((laneId: string) => {
    const laneName = lanesById.get(laneId)?.name ?? laneId;
    return new Promise<RebaseScope | null>((resolve) => {
      setRebaseScopePrompt({ laneId, laneName, resolve });
    });
  }, [lanesById]);

  const requestPushSelection = useCallback((run: RebaseRun) => {
    const succeededLanes = run.lanes
      .filter((lane) => lane.status === "succeeded")
      .map((lane) => ({ laneId: lane.laneId, laneName: lane.laneName, selected: true }));
    if (succeededLanes.length === 0) return Promise.resolve<string[] | null>([]);
    return new Promise<string[] | null>((resolve) => {
      setRebasePushReview({
        runId: run.runId,
        lanes: succeededLanes,
        resolve
      });
    });
  }, []);

  const runRebaseFlow = useCallback(async (laneId: string, mode: "local_only" | "local_and_remote") => {
    setRebaseSuggestionError(null);
    try {
      const scope = await requestRebaseScope(laneId);
      if (!scope) return;

      const start = await window.ade.lanes.rebaseStart({
        laneId,
        scope,
        pushMode: mode === "local_and_remote" ? "review_then_push" : "none",
        actor: "user"
      });

      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
        const failedLane = start.run.failedLaneId ? lanesById.get(start.run.failedLaneId)?.name ?? start.run.failedLaneId : null;
        const detail = start.run.error ?? "Rebase failed.";
        setRebaseSuggestionError(`Rebase needs attention${failedLane ? ` for ${failedLane}` : ""}. ${detail}`);
        navigate("/prs?tab=workflows&workflow=rebase");
        return;
      }

      if (mode === "local_and_remote") {
        const laneIds = await requestPushSelection(start.run);
        if (laneIds == null) return;
        if (laneIds.length > 0) {
          await window.ade.lanes.rebasePush({ runId: start.runId, laneIds });
        }
      }

      try {
        await refreshLanes();
      } catch (refreshErr) {
        console.error("Lane refresh failed:", refreshErr);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRebaseSuggestionError(message);
      navigate("/prs?tab=workflows&workflow=rebase");
    }
  }, [lanesById, navigate, refreshLanes, requestPushSelection, requestRebaseScope]);

  const hideRebaseSuggestionLocally = useCallback((laneId: string) => {
    appStore.setState((prev) => ({
      laneSnapshots: prev.laneSnapshots.map((snapshot) =>
        snapshot.lane.id === laneId ? { ...snapshot, rebaseSuggestion: null } : snapshot
      ),
    }));
  }, [appStore]);

  const hideAutoRebaseStatusLocally = useCallback((laneId: string) => {
    appStore.setState((prev) => ({
      laneSnapshots: prev.laneSnapshots.map((snapshot) =>
        snapshot.lane.id === laneId ? { ...snapshot, autoRebaseStatus: null } : snapshot
      ),
    }));
  }, [appStore]);

  const restoreRebaseSuggestionLocally = useCallback((laneId: string, suggestion: LaneListSnapshot["rebaseSuggestion"]) => {
    if (!suggestion) return;
    appStore.setState((prev) => ({
      laneSnapshots: prev.laneSnapshots.map((snapshot) =>
        snapshot.lane.id === laneId && snapshot.rebaseSuggestion == null
          ? { ...snapshot, rebaseSuggestion: suggestion }
          : snapshot
      ),
    }));
  }, [appStore]);

  const restoreAutoRebaseStatusLocally = useCallback((laneId: string, status: LaneListSnapshot["autoRebaseStatus"]) => {
    if (!status) return;
    appStore.setState((prev) => ({
      laneSnapshots: prev.laneSnapshots.map((snapshot) =>
        snapshot.lane.id === laneId && snapshot.autoRebaseStatus == null
          ? { ...snapshot, autoRebaseStatus: status }
          : snapshot
      ),
    }));
  }, [appStore]);

  const dismissRebaseSuggestion = async (laneId: string) => {
    const previous = appStore.getState().laneSnapshots.find((snapshot) => snapshot.lane.id === laneId)?.rebaseSuggestion ?? null;
    setRebaseSuggestionError(null);
    hideRebaseSuggestionLocally(laneId);
    try {
      await window.ade.lanes.dismissRebaseSuggestion({ laneId });
    } catch (err) {
      restoreRebaseSuggestionLocally(laneId, previous);
      setRebaseSuggestionError(err instanceof Error ? err.message : String(err));
    }
  };

  const dismissAutoRebaseStatus = async (laneId: string) => {
    const previous = appStore.getState().laneSnapshots.find((snapshot) => snapshot.lane.id === laneId)?.autoRebaseStatus ?? null;
    setRebaseSuggestionError(null);
    hideAutoRebaseStatusLocally(laneId);
    try {
      await window.ade.lanes.dismissAutoRebaseStatus({ laneId });
    } catch (err) {
      restoreAutoRebaseStatusLocally(laneId, previous);
      setRebaseSuggestionError(err instanceof Error ? err.message : String(err));
    }
  };

  const openAutoRebaseSettings = useCallback(() => { navigate("/settings?tab=lane-templates"); }, [navigate]);
  const openRebaseDetails = useCallback((laneId?: string | null) => {
    const trimmedLaneId = typeof laneId === "string" ? laneId.trim() : "";
    if (trimmedLaneId.length) {
      const search = buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: null,
        selectedQueueGroupId: null,
        selectedRebaseItemId: trimmedLaneId,
      });
      navigate(`/prs${search}`);
      return;
    }
    navigate("/prs?tab=workflows&workflow=rebase");
  }, [navigate]);

  const openRebaseConflictResolver = useCallback((laneId: string, parentLaneId: string | null) => {
    const search = new URLSearchParams(
      buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: null,
        selectedQueueGroupId: null,
        selectedRebaseItemId: laneId,
      }).slice(1),
    );
    if (parentLaneId) search.set("parentLaneId", parentLaneId);
    navigate(`/prs?${search.toString()}`);
  }, [navigate]);

  /* ---- Detail handlers ---- */

  const handleSelectFile = useCallback((laneId: string, path: string, mode: "staged" | "unstaged") => {
    setLanePaneDetails((prev) => ({
      ...prev,
      [laneId]: { selectedFilePath: path, selectedFileMode: mode, selectedCommit: null }
    }));
  }, []);

  const handleSelectCommit = useCallback((laneId: string, commit: GitCommitSummary | null) => {
    setLanePaneDetails((prev) => {
      const prevDetail = prev[laneId] ?? EMPTY_LANE_PANE_DETAIL;
      const nextDetail: LanePaneDetailSelection = commit
        ? { selectedFilePath: null, selectedFileMode: null, selectedCommit: commit }
        : { ...prevDetail, selectedCommit: null };
      return { ...prev, [laneId]: nextDetail };
    });
  }, []);

  const handleClearLanePaneDetailSelection = useCallback((laneId: string) => {
    setLanePaneDetails((prev) => ({ ...prev, [laneId]: EMPTY_LANE_PANE_DETAIL }));
  }, []);

  /* ---- Create/Attach lane submit handlers ---- */

  const resetCreateDialogState = useCallback(() => {
    createEnvInitLaneIdRef.current = null;
    createBaseBranchUserPickedRef.current = false;
    setLaneCreated(false);
    setCreateLaneName("");
    setCreateParentLaneId("");
    setCreateMode("primary");
    setCreateRuntimePlacement("local");
    setCreateVmStatus(null);
    setCreateVmStatusError(null);
    setCreateVmStatusLoading(false);
    setCreateVmRuntimeAuthConfirmed(readMacosVmRuntimeAuthConfirmed());
    setCreateBaseBranch("");
    setCreateImportBranch("");
    setCreateChildBaseBranch("");
    setCreateBusy(false);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase(null);
    setCreateVmSetupDetail(null);
    setSelectedTemplateId("");
    setCreateSelectedColor(null);
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
  }, []);

  const prepareCreateDialog = useCallback((options?: { runtimePlacement?: LaneRuntimePlacement }) => {
    const runtimePlacement = normalizeLaneRuntimePlacement(options?.runtimePlacement);
    setCreateLaneName("");
    setCreateParentLaneId("");
    setCreateMode("primary");
    setCreateRuntimePlacement(runtimePlacement);
    setCreateVmStatus(null);
    setCreateVmStatusError(null);
    setCreateVmStatusLoading(false);
    setCreateVmRuntimeAuthConfirmed(readMacosVmRuntimeAuthConfirmed());
    setCreateVmSetupDetail(null);
    setCreateBaseBranch("");
    setCreateImportBranch("");
    setCreateChildBaseBranch("");
    setCreateBranches([]);
    setCreateBranchPullRequests([]);
    setCreateGitUserName("");
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
    setCreateBranchesLoading(false);
    setCreateBranchPullRequestsLoading(false);
    setLaneCreated(false);
    createBaseBranchUserPickedRef.current = false;
    const primary = lanes.find((l) => l.laneType === "primary");
    if (primary) {
      // Fetch remotes first so remote-only branches (pushed from other machines) appear.
      setCreateBranchesLoading(true);
      window.ade.git.fetch({ laneId: primary.id })
        .catch(() => {})
        .then(() => window.ade.git.listBranches({ laneId: primary.id }))
        .then((branches) => {
          if (!branches) return;
          setCreateBranches(branches);
          // Default new root lanes to the project's base branch. Users can still
          // pick the current primary checkout explicitly when they want that.
          if (!createBaseBranchUserPickedRef.current) {
            const defaultBranch = branches.find((b) => !b.isRemote && b.name === primary.baseRef)
              ?? branches.find((b) => b.isCurrent && !b.isRemote)
              ?? branches.find((b) => !b.isRemote);
            if (defaultBranch) setCreateBaseBranch(defaultBranch.name);
          }
        })
        .catch(() => {})
        .finally(() => setCreateBranchesLoading(false));

      // Capture git user.name so the picker can resolve `mine` / `author:me`.
      window.ade.git.getUserIdentity({ laneId: primary.id })
        .then((identity) => setCreateGitUserName(identity?.name ?? ""))
        .catch(() => setCreateGitUserName(""));

      // Lazily attach open-PR metadata. Fail-soft — picker degrades gracefully.
      setCreateBranchPullRequestsLoading(true);
      window.ade.prs.listOpenForRepo()
        .then(setCreateBranchPullRequests)
        .catch(() => setCreateBranchPullRequests([]))
        .finally(() => setCreateBranchPullRequestsLoading(false));
    }
    Promise.all([
      window.ade.lanes.listTemplates().catch(() => [] as LaneTemplate[]),
      window.ade.lanes.getDefaultTemplate().catch(() => null),
    ]).then(([nextTemplates, defaultTemplateId]) => {
      setTemplates(nextTemplates);
      setSelectedTemplateId(
        defaultTemplateId && nextTemplates.some((template) => template.id === defaultTemplateId)
          ? defaultTemplateId
          : ""
      );
    });
    setCreateOpen(true);
  }, [lanes]);

  // Deep link handling: must not re-run on lane list refreshes, or a stale
  // ?laneId / focus=single from the URL overwrites the user's current tab/split
  // selection. Multi-lane ?laneIds= re-tries as `availableLaneIds` changes.

  useEffect(() => {
    if (urlLaneDeeplinks.action !== "create") return;
    prepareCreateDialog({
      runtimePlacement: normalizeLaneRuntimePlacement(urlLaneDeeplinks.runtimePlacement),
    });
    const next = new URLSearchParams(location.search);
    next.delete("action");
    next.delete("runtimePlacement");
    const search = next.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, { replace: true });
  }, [
    location.pathname,
    location.search,
    navigate,
    prepareCreateDialog,
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.runtimePlacement,
  ]);

  // ?action=manage&laneId=X opens ManageLaneDialog for that lane. Used by other
  // pages (graph, PR cleanup, Work-tab lane right-click) to route through the
  // canonical delete surface.
  useEffect(() => {
    if (urlLaneDeeplinks.action !== "manage") return;
    const targetId = urlLaneDeeplinks.laneId;
    if (!targetId) return;
    const lane = lanesById.get(targetId);
    if (!lane || lane.laneType === "primary" || deletingLaneIds.has(targetId)) return;
    setManagedLaneIds([targetId]);
    setLaneActionError(null);
    setDeleteForce(false);
    setDeleteMode("worktree");
    setDeleteRemoteName("origin");
    setDeleteConfirmText("");
    setManageOpen(true);
    setPulsingLaneId(targetId);
    // Scrub the action param so refreshes don't re-open.
    navigate(`${location.pathname}${buildLaneActionClearedSearch(location.search)}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlLaneDeeplinks.action, urlLaneDeeplinks.laneId, lanesById, deletingLaneIds]);

  // Clear the pulse marker shortly after it is set so the animation can replay.
  useEffect(() => {
    if (!pulsingLaneId) return;
    const t = window.setTimeout(() => setPulsingLaneId(null), 700);
    return () => window.clearTimeout(t);
  }, [pulsingLaneId]);

  // Handle additional Work-tab right-click actions that route to the Lanes tab.
  useEffect(() => {
    const action = urlLaneDeeplinks.action;
    if (!action) return;
    const laneId = urlLaneDeeplinks.laneId;
    let handled = false;
    if (action === "adopt" && laneId) {
      const lane = lanesById.get(laneId);
      if (lane && lane.laneType === "attached" && !deletingLaneIds.has(laneId)) {
        selectLane(laneId);
        reopenAdoptHint();
        requestAdoptAttachedLane(laneId);
        handled = true;
      }
    } else if (action === "split-open" && laneId) {
      if (!deletingLaneIds.has(laneId) && lanesById.has(laneId)) {
        const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
        setActiveLaneIds((prev) => mergeUnique(prev, [laneId], pinned));
        selectLane(laneId);
        handled = true;
      }
    } else if (action === "split-remove" && laneId) {
      removeSplitLane(laneId);
      handled = true;
    } else if (action === "split-close-others" && laneId) {
      const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
      setActiveLaneIds(mergeUnique([laneId], pinned));
      selectLane(laneId);
      handled = true;
    } else if (action === "select-all") {
      const allIds = filteredLanes.map((lane) => lane.id);
      setActiveLaneIds(allIds);
      handled = true;
    } else if (action === "batch") {
      const raw = urlLaneDeeplinks.laneIdsRaw;
      if (raw) {
        const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
        if (ids.length > 0) {
          openBatchManage(ids);
          handled = true;
        }
      }
    }
    if (!handled) return;
    if (laneId) setPulsingLaneId(laneId);
    navigate(`${location.pathname}${buildLaneActionClearedSearch(location.search)}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.laneId,
    urlLaneDeeplinks.laneIdsRaw,
    lanesById,
    deletingLaneIds,
    pinnedLaneIds,
    filteredLanes,
  ]);

  useEffect(() => {
    if (!shouldApplyLaneIdsDeepLink({
      action: urlLaneDeeplinks.action,
      laneIdsRaw: urlLaneDeeplinks.laneIdsRaw,
    })) return;
    const laneIdsSelection = resolveLaneIdsDeepLinkSelection({
      laneIdsRaw: urlLaneDeeplinks.laneIdsRaw,
      inspectorTabParam: urlLaneDeeplinks.inspectorTab,
      availableLaneIds,
      consumedSignature: consumedLaneIdsDeepLinkSignatureRef.current,
    });
    if (laneIdsSelection) {
      consumedLaneIdsDeepLinkSignatureRef.current = laneIdsSelection.signature;
      const valid = laneIdsSelection.laneIds;
      selectLane(valid[0]!);
      setActiveLaneIds(valid);
      setPinnedLaneIds(new Set());
      if (urlLaneDeeplinks.inspectorTab && valid[0]) {
        setLaneInspectorTab(valid[0], urlLaneDeeplinks.inspectorTab as LaneInspectorTab);
      }
    }
  }, [
    availableLaneIds,
    selectLane,
    setLaneInspectorTab,
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.laneIdsRaw,
    urlLaneDeeplinks.inspectorTab,
  ]);

  useEffect(() => {
    if (urlLaneDeeplinks.action) return;
    if (urlLaneDeeplinks.laneIdsRaw) return;
    consumedLaneIdsDeepLinkSignatureRef.current = null;
    const laneId = urlLaneDeeplinks.laneId;
    if (!laneId) return;
    if (deletingLaneIds.has(laneId)) return;
    selectLane(laneId);
    if (urlLaneDeeplinks.focus === "single") {
      setActiveLaneIds([laneId]);
    }
    if (urlLaneDeeplinks.inspectorTab) {
      setLaneInspectorTab(laneId, urlLaneDeeplinks.inspectorTab as LaneInspectorTab);
    }
  }, [
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.laneIdsRaw,
    urlLaneDeeplinks.laneId,
    urlLaneDeeplinks.focus,
    urlLaneDeeplinks.inspectorTab,
    deletingLaneIds,
    selectLane,
    setLaneInspectorTab,
  ]);

  useEffect(() => {
    if (!urlLaneDeeplinks.sessionId) return;
    focusSession(urlLaneDeeplinks.sessionId);
  }, [urlLaneDeeplinks.sessionId, focusSession]);

  const handleCreateDialogOpenChange = useCallback((open: boolean) => {
    if (!open && createBusy) return;
    if (!open) resetCreateDialogState();
    setCreateOpen(open);
  }, [createBusy, resetCreateDialogState]);

  useEffect(() => {
    if (!createOpen) return;
    // Always require the VM auth-confirm flag — earlier this short-circuit
    // allowed a deep-link / dialog-bus open with `runtimePlacement: "macos-vm"`
    // to fetch VM status and flip `createVmRuntimeAvailable` true even when
    // the user had never confirmed the VM auth prompt. Auth confirmation is a
    // prerequisite for any VM status fetch.
    if (!createVmRuntimeAuthConfirmed) return;
    let cancelled = false;
    setCreateVmStatusLoading(true);
    setCreateVmStatusError(null);
    window.ade.macosVm.getStatus({})
      .then((status) => {
        if (!cancelled) setCreateVmStatus(status);
      })
      .catch((error) => {
        if (!cancelled) setCreateVmStatusError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setCreateVmStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, createRuntimePlacement, createVmRuntimeAuthConfirmed]);

  useEffect(() => {
    if (!createOpen || createRuntimePlacement !== "macos-vm") return;
    void refreshLanes({ includeStatus: false }).catch(() => {
      // The VM status check below still reports provider availability. A stale
      // lane list is also checked again when the user submits.
    });
  }, [createOpen, createRuntimePlacement, refreshLanes]);

  useEffect(() => {
    if (!createOpen) return;
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      if (event.type === "status") {
        setCreateVmStatus(event.status);
        return;
      }
      if (event.type !== "operation") return;
      const laneId = createEnvInitLaneIdRef.current;
      if (laneId && event.laneId && event.laneId !== laneId) return;
      if (event.operation !== "provision" && event.operation !== "start") return;
      setCreateVmSetupDetail(event.message);
    });
    return unsubscribe;
  }, [createOpen]);

  const reservedVmLane = lanes.find((lane) => lane.runtimePlacement === "macos-vm" && !lane.archivedAt) ?? null;
  const createVmRuntimeAvailable = Boolean(
    createVmRuntimeAuthConfirmed
    && createVmStatus?.supported
    && createVmStatus.activeProvider.available
    && !createVmStatus.globalLease
    && createVmStatus.vms.length === 0
    && !reservedVmLane,
  );
  const createVmRuntimeUnavailableReason = reservedVmLane
    ? `A VM lane already exists: ${reservedVmLane.name}.`
    : !createVmRuntimeAuthConfirmed
      ? "Confirm Mac VM runtime access in the VM tab before creating a VM-backed lane."
      : createVmRuntimeStatusReason({
        loading: createVmStatusLoading,
        status: createVmStatus,
        error: createVmStatusError,
      });
  const createSetupStatus = useMemo(() => {
    switch (createSetupPhase) {
      case "creating":
        return createMode === "existing"
          ? "Importing branch and creating the lane worktree..."
          : "Creating the lane branch and worktree...";
      case "appearance":
        return "Saving lane appearance...";
      case "refreshing":
        return "Refreshing the lane list...";
      case "starting-vm":
        return createVmSetupDetail ?? "Opening the VM tab. VM install starts only when you press Set up VM there.";
      case "environment":
        return selectedTemplateId ? "Applying the lane template..." : "Running lane environment setup...";
      default:
        return laneCreated ? "Lane exists. Finish setup or retry the failed step." : null;
    }
  }, [createMode, createSetupPhase, createVmSetupDetail, laneCreated, selectedTemplateId]);
  const createSetupSteps = useMemo<CreateLaneSetupStep[]>(() => {
    if (!createBusy && !laneCreated) return [];
    let laneLabel: string;
    if (createMode === "child") laneLabel = "Create child lane";
    else if (createMode === "existing") laneLabel = "Import branch";
    else laneLabel = "Create lane";
    let laneState: CreateLaneSetupStep["state"];
    if (createSetupPhase === "creating") laneState = "active";
    else if (laneCreated) laneState = "done";
    else laneState = "pending";
    const steps: CreateLaneSetupStep[] = [{
      label: laneLabel,
      detail: "Create the branch metadata and worktree on disk.",
      state: laneState,
    }];
    if (createRuntimePlacement === "macos-vm") {
      steps.push({
        label: "Reserve VM lane",
        detail: "Tag this lane for the Mac VM. VM setup continues in the VM tab after creation.",
        state: laneCreated ? "done" : "pending",
      });
    } else {
      steps.push({
        label: selectedTemplateId ? "Apply template" : "Initialize environment",
        detail: selectedTemplateId
          ? "Run the selected lane template setup."
          : "Run the default lane setup checks.",
        state: createSetupPhase === "environment" ? "active" : "pending",
      });
    }
    return steps;
  }, [createBusy, createMode, createRuntimePlacement, createSetupPhase, laneCreated, selectedTemplateId]);

  /** Wraps setCreateBaseBranch so we can track user-driven selections and avoid
   *  the async branch-list fetch from overwriting a value the user already picked. */
  const handleSetCreateBaseBranch = useCallback((v: string) => {
    createBaseBranchUserPickedRef.current = true;
    setCreateBaseBranch(v);
  }, []);

  const handleSetCreateLinearIssue = useCallback((issue: LaneLinearIssue | null) => {
    setCreateSelectedLinearIssue(issue);
    if (!issue) return;

    const nextName = linearIssueLaneName(issue);
    setCreateLaneName((current) => {
      const trimmed = current.trim();
      const previousAutoName = createLinearIssueAutoNameRef.current;
      if (!trimmed || (previousAutoName && trimmed === previousAutoName)) {
        createLinearIssueAutoNameRef.current = nextName;
        return nextName;
      }
      createLinearIssueAutoNameRef.current = nextName;
      return current;
    });
    setCreateImportBranch("");
    setCreateMode((mode) => mode === "existing" ? "primary" : mode);
  }, []);

  /** Run post-create setup for a lane that already exists. Used as the retry path
   *  when environment setup fails. VM lanes are only reserved here; VM setup runs
   *  from the VM tab so lane creation never hides a long macOS install. */
  const runSetupForCreatedLane = useCallback(async (laneId: string) => {
    const shouldReturnToVm = createRuntimePlacement === "macos-vm";
    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateVmSetupDetail(null);
    setCreateSetupPhase(shouldReturnToVm ? "starting-vm" : "environment");

    try {
      if (shouldReturnToVm) {
        await refreshLanes({ includeStatus: false });
        resetCreateDialogState();
        setCreateOpen(false);
        navigate("/vm");
        return;
      }

      const envProgress = selectedTemplateId
        ? await window.ade.lanes.applyTemplate({ laneId, templateId: selectedTemplateId })
        : await window.ade.lanes.initEnv({ laneId });
      setCreateEnvInitProgress(envProgress);

      if (envProgress.overallStatus === "failed") {
        setCreateError("Environment setup failed. Review the progress log and retry.");
        return;
      }

      resetCreateDialogState();
      setCreateOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateSetupPhase(null);
      setCreateBusy(false);
    }
  }, [createRuntimePlacement, navigate, refreshLanes, selectedTemplateId, resetCreateDialogState]);

  const handleCreateSubmit = useCallback(async () => {
    // If the lane was already created (e.g. VM or env setup failed on a previous
    // attempt), retry setup only — never re-run creation.
    if (createEnvInitLaneIdRef.current) {
      await runSetupForCreatedLane(createEnvInitLaneIdRef.current);
      return;
    }

    const name = createLaneName.trim();
    if (!name || createBusy) return;
    if (createMode === "child" && !createParentLaneId) return;
    if (createMode === "primary" && !createBaseBranch) return;
    if (createMode === "existing" && !createImportBranch) return;
    if (createSelectedLinearIssue && createMode === "existing") {
      setCreateError("Detach the Linear issue before importing an existing branch.");
      return;
    }
    if (createRuntimePlacement === "macos-vm" && createMode === "existing") {
      setCreateError("VM-backed lanes must start from a base lane, not an imported branch.");
      return;
    }
    if (createRuntimePlacement === "macos-vm" && !createVmRuntimeAvailable) {
      setCreateError(createVmRuntimeUnavailableReason ?? "Complete VM setup before creating this lane.");
      return;
    }
    if (selectedTemplateId && !templates.some((template) => template.id === selectedTemplateId)) {
      setCreateError("The selected lane template no longer exists. Refresh templates or choose a different option.");
      return;
    }
    if (createRuntimePlacement === "macos-vm") {
      setCreateVmStatusLoading(true);
      try {
        const [freshStatus, freshLanes] = await Promise.all([
          window.ade.macosVm.getStatus({}),
          window.ade.lanes.list({ includeArchived: false, includeStatus: false }),
        ]);
        setCreateVmStatus(freshStatus);
        const freshReservedVmLane = freshLanes.find((lane) => lane.runtimePlacement === "macos-vm" && !lane.archivedAt) ?? null;
        // Mirror the full `createVmRuntimeAvailable` predicate so the
        // singleton-VM invariants (auth-confirmed, supported, no global
        // lease, no other VM running, no other VM lane) are all rechecked
        // against the fresh data. Earlier this only checked the reserved
        // lane + the loading-status reason, so a VM appearing or a
        // `globalLease` being taken between dialog-open and submit could
        // race past the gate.
        const freshVmAvailable = Boolean(
          createVmRuntimeAuthConfirmed
          && freshStatus.supported
          && freshStatus.activeProvider.available
          && !freshStatus.globalLease
          && freshStatus.vms.length === 0
          && !freshReservedVmLane,
        );
        if (!freshVmAvailable) {
          const reason = freshReservedVmLane
            ? `A VM lane already exists: ${freshReservedVmLane.name}.`
            : !createVmRuntimeAuthConfirmed
              ? "Confirm Mac VM runtime access in the VM tab before creating a VM-backed lane."
              : createVmRuntimeStatusReason({
                loading: false,
                status: freshStatus,
                error: null,
              }) ?? "Mac VM is no longer available for a new lane.";
          setCreateError(reason);
          return;
        }
      } catch (error) {
        setCreateError(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setCreateVmStatusLoading(false);
      }
    }

    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateVmSetupDetail(null);
    setCreateSetupPhase("creating");

    try {
      const request = resolveCreateLaneRequest({
        name,
        createMode,
        createParentLaneId,
        createBaseBranch,
        createImportBranch,
      });
      const linearIssueArgs = createSelectedLinearIssue
        ? {
          linearIssue: {
            ...createSelectedLinearIssue,
            branchName: linearIssueBranchName(createSelectedLinearIssue),
          },
          branchName: linearIssueBranchName(createSelectedLinearIssue),
        }
        : {};
      let lane: LaneSummary;
      if (request.kind === "import") {
        lane = await window.ade.lanes.importBranch(request.args);
      } else if (request.kind === "child") {
        const trimmedBase = createChildBaseBranch.trim();
        const parentLane = lanes.find((l) => l.id === request.args.parentLaneId);
        if (!parentLane) {
          setCreateError("Parent lane no longer exists. Please close and reopen the dialog.");
          setCreateBusy(false);
          setCreateSetupPhase(null);
          return;
        }
        const childArgs = trimmedBase && trimmedBase !== parentLane.branchRef
          ? { ...request.args, baseBranchRef: trimmedBase, ...linearIssueArgs }
          : { ...request.args, ...linearIssueArgs };
        lane = await window.ade.lanes.createChild({ ...childArgs, runtimePlacement: createRuntimePlacement });
      } else {
        lane = await window.ade.lanes.create({ ...request.args, ...linearIssueArgs, runtimePlacement: createRuntimePlacement });
      }

      // Lane created successfully — record its id so retries skip creation.
      createEnvInitLaneIdRef.current = lane.id;
      setLaneCreated(true);

      if (createSelectedColor) {
        try {
          setCreateSetupPhase("appearance");
          await window.ade.lanes.updateAppearance({ laneId: lane.id, color: createSelectedColor });
        } catch {
          // Color collisions or transient errors shouldn't block lane creation.
        }
      }

      if (createRuntimePlacement === "macos-vm") {
        setCreateSetupPhase("refreshing");
        await refreshLanes({ includeStatus: false });
        resetCreateDialogState();
        setCreateOpen(false);
        navigate("/vm");
        return;
      }
      setCreateSetupPhase("refreshing");
      await refreshLanes();
      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`);

      // Now run environment setup as a separate phase.
      await runSetupForCreatedLane(lane.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreateSetupPhase(null);
      setCreateBusy(false);
    }
  }, [
    createLaneName,
    createMode,
    createParentLaneId,
    createBaseBranch,
    createImportBranch,
    createChildBaseBranch,
    lanes,
    createBusy,
    createRuntimePlacement,
    createVmRuntimeAvailable,
    createVmRuntimeUnavailableReason,
    navigate,
    refreshLanes,
    resetCreateDialogState,
    runSetupForCreatedLane,
    selectedTemplateId,
    templates,
    createSelectedColor,
    createSelectedLinearIssue,
  ]);

  const handleAttachSubmit = useCallback(async () => {
    const name = attachName.trim();
    const attachedPath = attachPath.trim();
    if (!name || !attachedPath || attachBusy) return;
    setAttachBusy(true);
    setAttachError(null);
    try {
      const description = attachDescription.trim() || undefined;
      const lane = await window.ade.lanes.attach({ name, attachedPath, description });
      await refreshLanes();
      setAttachOpen(false);
      setAttachName("");
      setAttachPath("");
      setAttachDescription("");
      setAttachError(null);
      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachBusy(false);
    }
  }, [attachName, attachPath, attachDescription, attachBusy, refreshLanes, navigate]);

  const openManageDialog = useCallback((laneId: string) => {
    if (deletingLaneIds.has(laneId)) return;
    selectLane(laneId);
    setManagedLaneIds([laneId]);
    setLaneActionError(null);
    setAdoptError(null);
    setDeleteForce(false);
    setDeleteMode("worktree");
    setDeleteRemoteName("origin");
    setDeleteConfirmText("");
    setManageOpen(true);
  }, [deletingLaneIds, selectLane]);

  const handleCreateDialogBusOpen = useCallback((props?: Record<string, unknown>) => {
    setAddLaneDropdownOpen(false);
    setStackGraphHeaderOpen(false);
    prepareCreateDialog({
      runtimePlacement: normalizeLaneRuntimePlacement(props?.runtimePlacement),
    });
    const name = typeof props?.name === "string" ? props.name.trim() : "";
    if (name) setCreateLaneName(name);
  }, [prepareCreateDialog]);

  const handleManageDialogBusOpen = useCallback((props?: Record<string, unknown>) => {
    const requestedLaneId = typeof props?.laneId === "string" ? props.laneId : null;
    const requested = requestedLaneId ? lanesById.get(requestedLaneId) ?? null : null;
    const selected = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
    const fallback = sortedLanes.find((lane) => lane.laneType !== "primary") ?? null;
    const target =
      requested && requested.laneType !== "primary"
        ? requested
        : selected && selected.laneType !== "primary"
          ? selected
          : fallback;
    if (!target) return;
    openManageDialog(target.id);
  }, [lanesById, openManageDialog, selectedLaneId, sortedLanes]);

  useDialogBus("lanes.create", {
    onOpen: handleCreateDialogBusOpen,
    onClose: () => handleCreateDialogOpenChange(false),
  });

  useDialogBus("lanes.manage", {
    onOpen: handleManageDialogBusOpen,
    onClose: () => setManageOpen(false),
  });

  /* ---- Pane configs ---- */

  const getPaneConfigs = useCallback((laneId: string | null, surface: LanePaneSurface = "inline") => {
    const laneDetail = laneId ? lanePaneDetails[laneId] ?? EMPTY_LANE_PANE_DETAIL : EMPTY_LANE_PANE_DETAIL;
    const laneSnapshot = laneId ? laneSnapshotByLaneId.get(laneId) ?? null : null;
    const pendingLinearIssueContext =
      laneId && linearIssueChatContextRequest?.laneId === laneId
        ? linearIssueChatContextRequest
        : null;
    const mountGitActionsPane = shouldMountGitActionsPane({
      laneId,
      expandedGitActionsLaneId,
      surface,
    });
    return {
      "git-actions": {
        title: "Git Actions",
        icon: FileCode,
        dataTour: "lanes.gitActionsPane",
        headerActions: (
          <>
            <HelpChip termId="rebase" />
            {laneId ? (
              <SmartTooltip content={{ label: expandedGitActionsLaneId === laneId ? "Minimize" : "Expand", description: expandedGitActionsLaneId === laneId ? "Minimize the Git Actions pane back to its default size." : "Expand the Git Actions pane to fill the available space." }}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  title={expandedGitActionsLaneId === laneId ? "Minimize Git Actions pane" : "Expand Git Actions pane"}
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpandedLaneId(null);
                    setExpandedGitActionsLaneId((prev) => (prev === laneId ? null : laneId));
                  }}
                >
                  {expandedGitActionsLaneId === laneId ? <ArrowsInSimple size={12} /> : <ArrowsOutSimple size={12} />}
                </Button>
              </SmartTooltip>
            ) : null}
          </>
        ),
        bodyClassName: "overflow-hidden",
        children: mountGitActionsPane ? (
          <DeferredLanePane cacheKey={`git:${laneId ?? "none"}`} label="git actions">
            <LaneGitActionsPane
              laneId={laneId}
              autoRebaseEnabled={autoRebaseEnabled}
              autoRebaseStatusSnapshot={laneSnapshot?.autoRebaseStatus}
              onOpenSettings={openAutoRebaseSettings}
              onRebaseNowLocal={(targetLaneId) => runRebaseFlow(targetLaneId, "local_only")}
              onRebaseAndPush={(targetLaneId) => runRebaseFlow(targetLaneId, "local_and_remote")}
              onViewRebaseDetails={openRebaseDetails}
              onResolveRebaseConflict={openRebaseConflictResolver}
              selectedPath={laneDetail.selectedFilePath}
              selectedMode={laneDetail.selectedFileMode}
              selectedCommit={laneDetail.selectedCommit ?? null}
              selectedCommitSha={laneDetail.selectedCommit?.sha ?? null}
              onSelectFile={(path, mode) => { if (laneId) handleSelectFile(laneId, path, mode); }}
              onSelectCommit={(commit) => { if (laneId) handleSelectCommit(laneId, commit); }}
              onClearDiffSelection={laneId ? () => handleClearLanePaneDetailSelection(laneId) : undefined}
            />
          </DeferredLanePane>
        ) : null
      },
      "work": {
        title: "Work",
        icon: Terminal as any,
        bodyClassName: "overflow-hidden",
        dataTour: "lanes.workPane",
        hideHeaderWhenExpanded: true,
        children: (
          <DeferredLanePane cacheKey={`work:${laneId ?? "none"}`} label="work">
            <LaneWorkPane
              laneId={laneId}
              initialLinearIssueContext={pendingLinearIssueContext?.issue ?? null}
              onInitialLinearIssueContextConsumed={
                pendingLinearIssueContext
                  ? () => {
                    setLinearIssueChatContextRequest((current) => (
                      current?.laneId === pendingLinearIssueContext.laneId
                      && current.requestedAt === pendingLinearIssueContext.requestedAt
                        ? null
                        : current
                    ));
                  }
                  : undefined
              }
            />
          </DeferredLanePane>
        )
      },
    };
  }, [
    lanePaneDetails,
    laneSnapshotByLaneId,
    linearIssueChatContextRequest,
    expandedGitActionsLaneId,
    autoRebaseEnabled,
    openAutoRebaseSettings,
    runRebaseFlow,
    openRebaseDetails,
    openRebaseConflictResolver,
    handleSelectFile,
    handleSelectCommit,
    handleClearLanePaneDetailSelection,
  ]);

  /* ---- Render ---- */

  return (
    <div data-route="lanes" className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
      {/* Header bar */}
      <div style={{ padding: "0 24px", height: 64, display: "flex", alignItems: "center", gap: 24, background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: `1px solid ${COLORS.border}`, position: "relative", zIndex: 50, overflow: "visible" }}>
        {/* Numbered title group */}
        <div className="flex items-center gap-2 shrink-0">
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.accent }}>05</span>
          <GitBranch size={18} style={{ color: COLORS.accent }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700, color: COLORS.textPrimary }}>LANES</span>
          <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{filteredLanes.length}</span>
        </div>

        {/* Branch selector */}
        {branchLane ? (
          <div className="relative shrink-0 flex items-center" ref={branchDropdownRef}>
            <SmartTooltip
              content={{
                label: canSwitchBranchLane ? `Branch — ${branchLane.name}` : `Branch — ${branchLane.name} (read-only)`,
                description: branchLaneSwitchDisabledReason ?? `Switch ${branchLane.name} to a local or remote branch.`,
                docUrl: docs.lanesOverview,
              }}
              side="bottom"
            >
              <button
                type="button"
                data-tour="lanes.branchSelector"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "0 12px", height: 32, fontSize: 12, fontFamily: MONO_FONT, fontWeight: 600,
                  color: canSwitchBranchLane ? COLORS.success : COLORS.textMuted,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8,
                  cursor: canSwitchBranchLane ? "pointer" : "not-allowed",
                  opacity: canSwitchBranchLane ? 1 : 0.65,
                }}
                onClick={() => {
                  if (!canSwitchBranchLane) return;
                  setStackGraphHeaderOpen(false);
                  setBranchDropdownOpen((prev) => !prev);
                }}
                disabled={branchCheckoutBusy || !canSwitchBranchLane}
                aria-disabled={!canSwitchBranchLane}
                title={branchLaneSwitchDisabledReason ?? undefined}
              >
                <GitBranch size={14} />
                <span>{branchLane.branchRef}</span>
                <CaretDown size={12} style={{ opacity: canSwitchBranchLane ? 0.6 : 0.3 }} />
              </button>
            </SmartTooltip>
            {branchDropdownOpen && canSwitchBranchLane ? (
              <div className="ade-liquid-glass-menu absolute left-0 top-full z-[200] mt-1 max-h-[480px] overflow-hidden flex flex-col" style={{ width: 360, maxWidth: 360, minWidth: 0, padding: "4px 0", border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.cardBgSolid, backdropFilter: "blur(24px) saturate(150%)", WebkitBackdropFilter: "blur(24px) saturate(150%)", boxShadow: "0 24px 56px -20px rgba(0, 0, 0, 0.7)", boxSizing: "border-box" }}>
                <div className="relative shrink-0" style={{ padding: "4px 8px" }}>
                  <MagnifyingGlass size={13} className="pointer-events-none absolute" style={{ left: 16, top: "50%", transform: "translateY(-50%)", color: COLORS.textDim }} />
                  <input
                    ref={branchSearchInputRef}
                    type="text"
                    placeholder="Search branches…"
                    value={branchSearchQuery}
                    onChange={(e) => setBranchSearchQuery(e.target.value)}
                    style={{
                      width: "100%", padding: "5px 8px 5px 28px", fontSize: 12, fontFamily: MONO_FONT,
                      color: COLORS.textPrimary, background: "rgba(255,255,255,0.04)",
                      border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 6, outline: "none",
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
                  />
                </div>
                {newBranchFormOpen ? (
                  <div style={{ padding: "8px 10px", borderTop: `1px solid ${COLORS.border}`, borderBottom: `1px solid ${COLORS.border}` }}>
                    <div style={{ display: "grid", gap: 8 }}>
                      <div className="flex items-center justify-between">
                        <div style={{ fontSize: 9, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "1px", color: COLORS.textDim }}>NEW BRANCH</div>
                        <button
                          type="button"
                          onClick={() => { setNewBranchFormOpen(false); setNewBranchName(""); }}
                          style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
                        >
                          Cancel
                        </button>
                      </div>
                      <input
                        type="text"
                        placeholder="feature/short-name"
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        aria-invalid={Boolean(newBranchName.trim()) && !branchNameValidation.ok}
                        autoFocus
                        style={{
                          width: "100%", padding: "6px 8px", fontSize: 12, fontFamily: MONO_FONT,
                          color: COLORS.textPrimary, background: "rgba(255,255,255,0.04)",
                          border: `1px solid ${
                            newBranchName.trim() && !branchNameValidation.ok ? COLORS.danger : COLORS.outlineBorder
                          }`,
                          borderRadius: 6, outline: "none",
                        }}
                      />
                      {newBranchName.trim() && branchNameValidation.reason ? (
                        <div style={{ fontSize: 11, color: COLORS.danger }}>{branchNameValidation.reason}</div>
                      ) : null}
                      <label className="flex flex-col gap-1" title="Git branch the new branch is forked from.">
                        <span style={{ fontSize: 9, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "1px", color: COLORS.textDim }}>START FROM</span>
                        <select
                          value={newBranchStartPoint || branchLane.branchRef}
                          onChange={(e) => setNewBranchStartPoint(e.target.value)}
                          style={{
                            width: "100%", minWidth: 0, maxWidth: "100%", height: 30, fontSize: 12, fontFamily: MONO_FONT,
                            color: COLORS.textPrimary, background: "rgba(255,255,255,0.04)",
                            border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 6, padding: "0 8px",
                            boxSizing: "border-box", textOverflow: "ellipsis",
                          }}
                        >
                          {startPointOptions.map((opt) => <option key={`start:${opt.value}`} value={opt.value}>{opt.label}</option>)}
                        </select>
                        <span style={{ fontSize: 10, color: COLORS.textDim }}>The commit your new branch is forked from.</span>
                      </label>
                      <label className="flex flex-col gap-1" title="ADE compares this lane's commits against this base for rebase / merge readiness.">
                        <span style={{ fontSize: 9, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "1px", color: COLORS.textDim }}>REBASE BASE</span>
                        <select
                          value={newBranchBaseRef || primaryLane?.branchRef || branchLane.baseRef}
                          onChange={(e) => setNewBranchBaseRef(e.target.value)}
                          style={{
                            width: "100%", minWidth: 0, maxWidth: "100%", height: 30, fontSize: 12, fontFamily: MONO_FONT,
                            color: COLORS.textPrimary, background: "rgba(255,255,255,0.04)",
                            border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 6, padding: "0 8px",
                            boxSizing: "border-box", textOverflow: "ellipsis",
                          }}
                        >
                          {baseRefOptions.map((name) => <option key={`base:${name}`} value={name}>{name}</option>)}
                        </select>
                        <span style={{ fontSize: 10, color: COLORS.textDim }}>What ADE compares this lane against for rebase / merge readiness.</span>
                      </label>
                      <button
                        type="button"
                        className="flex w-full items-center justify-center gap-2"
                        style={{
                          height: 30, border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 6,
                          background: "rgba(255,255,255,0.05)", color: COLORS.textPrimary,
                          fontSize: 12, fontFamily: SANS_FONT,
                          cursor: branchNameValidation.ok && !branchCheckoutBusy ? "pointer" : "not-allowed",
                          opacity: branchNameValidation.ok && !branchCheckoutBusy ? 1 : 0.5,
                        }}
                        disabled={branchCheckoutBusy || !branchNameValidation.ok}
                        onClick={async () => {
                          await checkoutLaneBranch({
                            branchName: newBranchName,
                            mode: "create",
                            startPoint: newBranchStartPoint || branchLane.branchRef,
                            baseRef: newBranchBaseRef || primaryLane?.branchRef || branchLane.baseRef,
                          });
                        }}
                      >
                        <Plus size={13} />
                        <span>Create in this lane</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2"
                    onClick={() => setNewBranchFormOpen(true)}
                    style={{
                      padding: "8px 12px", border: "none",
                      borderTop: `1px solid ${COLORS.border}`, borderBottom: `1px solid ${COLORS.border}`,
                      background: "transparent", color: COLORS.textSecondary,
                      fontSize: 12, fontFamily: SANS_FONT, cursor: "pointer", textAlign: "left",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <Plus size={13} />
                    <span>New branch…</span>
                  </button>
                )}
                {pendingBranchSwitch ? (
                  <div style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-warning) 12%, transparent)" }}>
                    <div style={{ fontSize: 12, color: COLORS.textPrimary, fontWeight: 600 }}>This lane has active work.</div>
                    <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>Terminals and processes stay attached to this lane and will keep running on the new branch's worktree.</div>
                    <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
                      {pendingBranchSwitch.activeWork.slice(0, 3).map((item) => (
                        <div key={`${item.kind}:${item.id}`} className="truncate" style={{ fontSize: 11, color: COLORS.textSecondary }}>
                          {item.kind === "terminal" ? "Terminal" : "Process"}: {item.title}
                        </div>
                      ))}
                      {pendingBranchSwitch.activeWork.length > 3 ? (
                        <div style={{ fontSize: 11, color: COLORS.textDim }}>+ {pendingBranchSwitch.activeWork.length - 3} more</div>
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        style={{
                          fontSize: 11, padding: "4px 8px", height: 26,
                          border: `1px solid ${COLORS.warning}`, borderRadius: 6,
                          background: "color-mix(in srgb, var(--color-warning) 25%, transparent)", color: COLORS.warning,
                          fontFamily: SANS_FONT, fontWeight: 600, cursor: "pointer",
                        }}
                        onClick={async () => {
                          await checkoutLaneBranch({ ...pendingBranchSwitch, acknowledgeActiveWork: true });
                        }}
                      >
                        Switch anyway
                      </button>
                      <button
                        type="button"
                        style={{ ...outlineButton({ fontSize: 11, padding: "4px 8px", height: 26 }) }}
                        onClick={() => setPendingBranchSwitch(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="overflow-auto flex-1" style={{ padding: "2px 0" }}>
                {laneBranchesLoading && laneBranches.length === 0 ? (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: COLORS.textMuted }}>Loading branches…</div>
                ) : null}
                <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>LOCAL BRANCHES</div>
                {localLaneBranches.map((branch) => {
                  const owned = Boolean(branch.ownedByLaneId);
                  return (
                  <button
                    key={`local:${branch.name}`}
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    style={{
                      padding: "6px 12px", fontSize: 12, fontFamily: MONO_FONT,
                      color: branch.isCurrent ? COLORS.success : COLORS.textMuted,
                      fontWeight: branch.isCurrent ? 600 : 400,
                      background: "transparent", border: "none",
                      cursor: branch.isCurrent || owned ? "not-allowed" : "pointer",
                      opacity: owned ? 0.6 : 1,
                    }}
                    disabled={branchCheckoutBusy || branch.isCurrent || owned}
                    title={owned ? `Already active in ${branch.ownedByLaneName ?? "another lane"}` : undefined}
                    onClick={async () => {
                      if (branch.isCurrent) return;
                      await checkoutLaneBranch({ branchName: branch.name });
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {branch.isCurrent ? <Check size={12} className="shrink-0" /> : <span className="shrink-0" style={{ width: 12 }} />}
                    <span className="truncate">{branch.name}</span>
                    {branch.ownedByLaneName ? <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.warning }}>in {branch.ownedByLaneName}</span> : null}
                    {!branch.ownedByLaneName && branch.upstream ? <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.textDim }}>tracked</span> : null}
                  </button>
                  );
                })}
                {remoteLaneBranches.length > 0 ? (
                  <>
                    <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
                    <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>REMOTE BRANCHES</div>
                    {remoteLaneBranches.map((branch) => {
                      const owned = Boolean(branch.ownedByLaneId);
                      return (
                      <button
                        key={`remote:${branch.name}`}
                        type="button"
                        className="flex w-full items-center gap-2 text-left"
                        style={{
                          padding: "6px 12px", fontSize: 12, fontFamily: MONO_FONT,
                          color: COLORS.textMuted, background: "transparent", border: "none",
                          cursor: owned ? "not-allowed" : "pointer",
                          opacity: owned ? 0.6 : 1,
                        }}
                        disabled={branchCheckoutBusy || owned}
                        title={owned ? `Already active in ${branch.ownedByLaneName ?? "another lane"}` : undefined}
                        onClick={async () => { await checkoutLaneBranch({ branchName: branch.name }); }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <span className="shrink-0" style={{ width: 12 }} />
                        <span className="truncate">{branch.name}</span>
                        {branch.ownedByLaneName ? (
                          <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.warning }}>in {branch.ownedByLaneName}</span>
                        ) : (
                          <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.info }}>remote</span>
                        )}
                      </button>
                      );
                    })}
                  </>
                ) : null}
                {!laneBranchesLoading && localLaneBranches.length === 0 && remoteLaneBranches.length === 0 ? (
                  <div style={{ padding: "6px 12px", fontSize: 12, color: COLORS.textMuted }}>{branchSearchQuery ? "No matching branches." : "No branches found."}</div>
                ) : null}
                {branchCheckoutError ? (
                  <div style={{ padding: "6px 12px", fontSize: 11, color: COLORS.danger }}>{branchCheckoutError}</div>
                ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {branchCheckoutError && branchLane && !branchDropdownOpen ? (
          <div className="inline-flex items-center gap-2 shrink-0" style={{ border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)", background: "color-mix(in srgb, var(--color-error) 15%, transparent)", borderRadius: 8, padding: "4px 8px", fontSize: 12, color: COLORS.danger }}>
            <span>{branchCheckoutError}</span>
            <button
              type="button"
              style={{ background: "transparent", border: "none", padding: "0 4px", color: COLORS.danger, cursor: "pointer", fontSize: 14 }}
              onClick={() => setBranchCheckoutError(null)}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {/* Filter input */}
        <div className="relative flex items-center shrink-0">
          <MagnifyingGlass size={14} className="pointer-events-none absolute" style={{ left: 8, color: COLORS.textDim }} />
          <input
            id="lanes-filter-input"
            data-tour="lanes.filter"
            value={laneFilter}
            onChange={(event) => setLaneFilter(event.target.value)}
            placeholder="FILTER LANES"
            title="Filter lanes (is:dirty is:pinned type:worktree)"
            style={{
              height: 32, width: 200, padding: "0 28px 0 28px", fontSize: 11,
              fontFamily: MONO_FONT, background: "rgba(255,255,255,0.03)",
              border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8, color: COLORS.textSecondary,
              outline: "none", textTransform: "uppercase", letterSpacing: "1px",
            }}
          />
          {laneFilter.trim().length > 0 ? (
            <button
              type="button"
              className="absolute"
              style={{ right: 4, top: "50%", transform: "translateY(-50%)", display: "inline-flex", width: 20, height: 20, alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: COLORS.textMuted, cursor: "pointer" }}
              onClick={() => setLaneFilter("")}
              title="Clear filter"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        {laneActionError ? (
          <div
            className="inline-flex max-w-[420px] shrink-0 items-center gap-2 rounded-md border px-2 py-1"
            style={{
              borderColor: "color-mix(in srgb, var(--color-error) 30%, transparent)",
              background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
              color: COLORS.danger,
              fontFamily: SANS_FONT,
              fontSize: 11,
            }}
            title={laneActionError}
          >
            <span className="truncate">{laneActionError.split(/\r?\n/)[0]?.trim() || "Lane action failed"}</span>
            <button
              type="button"
              className="shrink-0"
              style={{ background: "transparent", border: "none", color: COLORS.danger, cursor: "pointer", padding: 0 }}
              onClick={() => {
                laneDeleteWarningMessagesRef.current.clear();
                setLaneActionError(null);
              }}
              title="Dismiss"
            >
              <X size={11} />
            </button>
          </div>
        ) : null}

        {/* NEW LANE button + dropdown */}
        <div className="relative shrink-0" ref={addLaneDropdownRef}>
          <SmartTooltip content={{ label: "New Lane", description: "Create a new lane from the primary branch, an existing branch, or as a child of another lane.", docUrl: docs.lanesCreating }}>
            <button
              type="button"
              data-tour="lanes.newLane"
              style={primaryButton({ height: 32, padding: "0 12px", fontSize: 10 })}
              disabled={!canCreateLane}
              onClick={() => {
                setStackGraphHeaderOpen(false);
                setAddLaneDropdownOpen((prev) => !prev);
              }}
            >
              <Plus size={12} /> NEW LANE
            </button>
          </SmartTooltip>
          {addLaneDropdownOpen ? (
            <div className="absolute left-0 top-full z-[200] mt-2 w-60 rounded-xl p-1 shadow-float" style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}` }}>
              <button
                type="button"
                data-tour="lanes.createNewLane"
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg"
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  prepareCreateDialog();
                }}
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-accent">
                  <Plus size={14} />
                </span>
                <span>
                  <span className="block font-medium">Create new lane</span>
                  <span className="block text-xs text-muted-fg/70">Start from primary or stack from another lane.</span>
                </span>
              </button>
              <button
                type="button"
                data-tour="lanes.addWorktrees"
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg"
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  setMultiAttachOpen(true);
                }}
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-info">
                  <Link size={14} />
                </span>
                <span>
                  <span className="block font-medium">Add existing worktrees as lanes</span>
                  <span className="block text-xs text-muted-fg/70">Select from worktrees that already exist on disk.</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>

        {filteredLanes.length > 0 ? (
          <div className="relative shrink-0" ref={stackGraphHeaderRef}>
            <SmartTooltip
              content={{
                label: "Stack graph",
                description: "Parent/child lane relationships and ahead/behind — same view as the Stack tile.",
              }}
            >
              <button
                type="button"
                data-tour="lanes.stackGraphHeader"
                aria-expanded={stackGraphHeaderOpen}
                className="inline-flex items-center gap-1.5 shrink-0"
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.8px",
                  textTransform: "uppercase",
                  color: stackGraphHeaderOpen ? COLORS.accent : COLORS.textMuted,
                  background: stackGraphHeaderOpen ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent",
                  border: `1px solid ${stackGraphHeaderOpen ? COLORS.accent : COLORS.outlineBorder}`,
                  borderRadius: 6,
                  padding: "0 10px",
                  height: 28,
                  cursor: "pointer",
                }}
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  setBranchDropdownOpen(false);
                  setStackGraphHeaderOpen((prev) => !prev);
                }}
                onMouseEnter={(e) => {
                  if (stackGraphHeaderOpen) return;
                  e.currentTarget.style.borderColor = COLORS.accent;
                  e.currentTarget.style.color = COLORS.accent;
                }}
                onMouseLeave={(e) => {
                  if (stackGraphHeaderOpen) return;
                  e.currentTarget.style.borderColor = COLORS.outlineBorder;
                  e.currentTarget.style.color = COLORS.textMuted;
                }}
              >
                <Stack size={12} weight="bold" />
                Stack graph
                <CaretDown size={10} style={{ opacity: 0.65 }} />
              </button>
            </SmartTooltip>
            {stackGraphHeaderOpen ? (
              <div
                className="absolute left-0 top-full z-[200] mt-2 flex flex-col overflow-hidden rounded-xl shadow-float"
                style={{
                  width: 400,
                  maxWidth: "min(400px, calc(100vw - 48px))",
                  height: "min(520px, 70vh)",
                  background: COLORS.cardBgSolid,
                  border: `1px solid ${COLORS.outlineBorder}`,
                }}
              >
                <LaneStackPane
                  lanes={stackGraphLanes}
                  selectedLaneId={selectedLaneId}
                  onSelect={(id) => {
                    handleLaneSelect(id, { extend: false });
                    setStackGraphHeaderOpen(false);
                  }}
                  runtimeByLaneId={laneRuntimeById}
                  integrationSourcesByLaneId={integrationSourcesByLaneId}
                  onStartChatWithLinearIssue={handleStartChatWithLinearIssue}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {shouldShowAdoptHint && selectedAttachedLane ? (
          <div
            className="shrink-0 flex items-center gap-2 rounded-lg border px-2 py-1"
            style={{ borderColor: "color-mix(in srgb, var(--color-info) 55%, transparent)", background: "color-mix(in srgb, var(--color-info) 15%, transparent)" }}
          >
            <SmartTooltip content={{ label: "Move to .ade", description: "Move this attached worktree into .ade/worktrees for full ADE management. Uses git worktree move — branch and history stay the same.", docUrl: docs.lanesCreating }}>
              <button
                type="button"
                data-tour="lanes.moveToAde"
                className="inline-flex items-center gap-1"
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  letterSpacing: "0.8px",
                  color: COLORS.info,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer"
                }}
                title={`Move '${selectedAttachedLane.name}' to .ade/worktrees`}
                onClick={() => requestAdoptAttachedLane(selectedAttachedLane.id)}
              >
                <ArrowSquareOut size={12} />
                MOVE TO .ADE
              </button>
            </SmartTooltip>
            <div className="relative group">
              <Info size={12} style={{ color: COLORS.info }} />
              <div
                className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border px-2 py-1 text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
                style={{
                  borderColor: `${COLORS.border}`,
                  background: COLORS.cardBg,
                  color: COLORS.textSecondary
                }}
              >
                Uses git worktree move. Branch/history stay the same.
              </div>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center"
              style={{ width: 16, height: 16, border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer" }}
              onClick={dismissAdoptHint}
              title="Dismiss this hint"
            >
              <X size={10} />
            </button>
          </div>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1, height: 1 }} />

        {/* Reset grid + Stats */}
        {visibleLaneIds.length > 0 ? (
          <SmartTooltip content={{ label: "Reset Grid", description: "Reset all lane column widths and panel arrangements back to their default layout." }}>
            <button
              type="button"
              data-tour="lanes.resetGrid"
              title="Reset grid to default layout"
              onClick={() => {
                void resetGridLayout(selectedLaneId);
              }}
              className="inline-flex items-center gap-1 shrink-0"
              style={{
                fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, letterSpacing: "0.8px",
                textTransform: "uppercase", color: COLORS.textMuted, background: "transparent",
                border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 6,
                padding: "0 8px", height: 24, cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textMuted; }}
            >
              <ArrowCounterClockwise size={10} /> RESET GRID
            </button>
          </SmartTooltip>
        ) : null}
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "0.5px", color: COLORS.textMuted, whiteSpace: "nowrap" }}>
          {sortedLanes.length} lane{sortedLanes.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Lane tabs -- horizontal numbered tab bar */}
      <div className="flex items-center select-none overflow-x-auto" style={{ background: "rgba(255,255,255,0.01)", borderBottom: `1px solid ${COLORS.border}` }}>
        {filteredLanes.length > 0 ? (
          <div className="flex items-center shrink-0 pl-2">
            <HelpChip termId="lane" side="bottom" />
          </div>
        ) : null}
        {filteredLanes.map((lane, index) => {
          const isVisible = visibleLaneIds.includes(lane.id);
          const isSelected = selectedLaneId === lane.id;
          const isInSplit = isVisible && !isSelected;
          const isPrimary = lane.laneType === "primary";
          const isPinned = pinnedLaneIds.has(lane.id);
          const closable = isVisible && visibleLaneIds.length > 1 && !isPinned;
          const laneSnapshot = laneSnapshotByLaneId.get(lane.id) ?? null;
          const laneRuntime = laneRuntimeById.get(lane.id) ?? {
            bucket: "none",
            runningCount: 0,
            awaitingInputCount: 0,
            endedCount: 0,
            sessionCount: 0,
          };
          const rebaseSuggestion = suppressTourDistractions ? null : laneSnapshot?.rebaseSuggestion ?? null;
          const autoRebaseStatus = laneSnapshot?.autoRebaseStatus ?? null;
          const devicesOpen = lane.devicesOpen ?? [];
          const tabNumber = String(index + 1).padStart(2, "0");
          const lanePr = lanePrByLaneId.get(lane.id) ?? null;
          const deleteProgress = deleteProgressByLaneId[lane.id] ?? null;
          const isDeleting = isLaneDeleteProgressActive(deleteProgress);
          const showMergedManageShortcut = !isDeleting && !isPrimary && lanePr?.state === "merged";

          return (
            <div
              key={lane.id}
              data-tour={isSelected && !isPrimary && !isDeleting ? "lanes.laneTab" : undefined}
              role="button"
              tabIndex={isDeleting ? -1 : 0}
              aria-disabled={isDeleting}
              // Drag the lane row out of ADE to drop an "Open in ADE" rich link
              // into chat apps (Slack/Mail/Messages). Receivers see a properly
              // titled URL rather than a raw string.
              // Note: the dragged URL is the lane-UUID form. Cross-machine
              // branch+repo links require an async lookup against the GitHub
              // remote; we use the right-click "Copy Branch Link" menu item
              // for that path. Lane links still resolve correctly on the
              // sender's own other devices.
              draggable={!isDeleting}
              onDragStart={(event) => {
                if (isDeleting) return;
                const url = `ade://lane/${encodeURIComponent(lane.id)}`;
                const escapeHtml = (value: string): string =>
                  value
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;");
                const title = escapeHtml(lane.name ?? "ADE lane");
                event.dataTransfer.effectAllowed = "copyLink";
                event.dataTransfer.setData("text/uri-list", url);
                event.dataTransfer.setData("text/plain", url);
                event.dataTransfer.setData(
                  "text/html",
                  `<a href="${url}">${title}</a>`,
                );
              }}
              className={`group flex items-center gap-2 shrink-0${pulsingLaneId === lane.id ? " ade-lane-row-pulse" : ""}`}
              style={{
                position: "relative",
                padding: "0 16px",
                height: 44,
                borderLeft: isSelected
                  ? `2px solid ${COLORS.accent}`
                  : isInSplit
                    ? `2px solid rgba(167,139,250,0.35)`
                    : "2px solid transparent",
                background: isSelected
                  ? COLORS.accentSubtle
                  : isInSplit
                    ? "rgba(167,139,250,0.06)"
                    : "transparent",
                borderBottom: isInSplit
                  ? `1px solid rgba(167,139,250,0.18)`
                  : "1px solid transparent",
                cursor: isDeleting ? "not-allowed" : "pointer",
                opacity: isDeleting ? 0.62 : 1,
              }}
              onClick={(event) => {
                if (isDeleting) return;
                handleLaneSelect(lane.id, {
                  extend: Boolean(event.shiftKey || event.metaKey || event.ctrlKey)
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (isDeleting) return;
                setLaneContextMenu({ laneId: lane.id, x: event.clientX, y: event.clientY });
              }}
              onMouseEnter={(e) => {
                if (!isDeleting && !isSelected && !isInSplit) e.currentTarget.style.background = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = isInSplit ? "rgba(167,139,250,0.06)" : "transparent";
              }}
            >
              {/* Tab number / merged-PR manage shortcut */}
              <span
                className="group/merged-manage relative inline-flex shrink-0 items-center justify-center"
                style={{ width: 20, height: 20 }}
              >
                <span
                  className={showMergedManageShortcut ? "transition-opacity group-hover/merged-manage:opacity-0" : undefined}
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "1px",
                    color: isSelected ? COLORS.accent : COLORS.textDim,
                  }}
                >
                  {tabNumber}
                </span>
                {showMergedManageShortcut ? (
                  <button
                    type="button"
                    aria-label={`Manage ${lane.name}`}
                    className="absolute inset-0 inline-flex items-center justify-center rounded-full opacity-0 transition-opacity group-hover/merged-manage:opacity-100 focus-visible:opacity-100"
                    style={{
                      border: `1px solid color-mix(in srgb, ${COLORS.danger} 45%, transparent)`,
                      background: `color-mix(in srgb, ${COLORS.danger} 14%, transparent)`,
                      color: COLORS.danger,
                      cursor: "pointer",
                    }}
                    title="PR merged. Manage lane"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      openManageDialog(lane.id);
                    }}
                  >
                    <X size={11} weight="bold" />
                  </button>
                ) : null}
              </span>
              {/* Terminal attention state */}
              {!isDeleting && (laneRuntime.bucket === "running" || laneRuntime.bucket === "awaiting-input") ? (
                <span
                  title={
                    laneRuntime.bucket === "awaiting-input"
                      ? `${laneRuntime.awaitingInputCount} session${laneRuntime.awaitingInputCount === 1 ? "" : "s"} awaiting input`
                      : `${laneRuntime.runningCount} session${laneRuntime.runningCount === 1 ? "" : "s"} running`
                  }
                  className="shrink-0"
                  style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: laneRuntime.bucket === "awaiting-input" ? COLORS.warning : COLORS.success,
                  }}
                />
              ) : !isDeleting && laneRuntime.bucket === "ended" ? (
                <span
                  title={`${laneRuntime.endedCount} ended session${laneRuntime.endedCount === 1 ? "" : "s"}`}
                  className="shrink-0"
                  style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger }}
                />
              ) : null}
              {!isDeleting ? (
                <span
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <QuickRunMenu laneId={lane.id} compact iconOnly triggerStyle={{ height: 22, padding: "0 6px" }} />
                </span>
              ) : null}
              {/* Lane name */}
              <span className="truncate" style={{
                maxWidth: 180,
                fontFamily: SANS_FONT, fontSize: 12, letterSpacing: "0.5px", textTransform: "uppercase",
                fontWeight: isSelected ? 600 : 500,
                color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
              }}>{lane.name}</span>
              {!isDeleting && lane.linearIssue ? (
                <LinearIssueBadge
                  issue={lane.linearIssue}
                  compact
                  onStartChatWithIssue={() => handleStartChatWithLinearIssue(lane.id, lane.linearIssue!)}
                />
              ) : null}
              {!isDeleting && lanePr ? (
                <button
                  type="button"
                  className="shrink-0"
                  style={{
                    ...inlineBadge(lanePrTagColor(lanePr.state), { fontSize: 9 }),
                    gap: 4,
                    cursor: "pointer",
                    borderRadius: 6,
                  }}
                  title={`${formatPrBadgeLabel(lanePr)}: ${lanePr.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (lanePr.linkedPrId) {
                      navigate(`/prs${buildPrsRouteSearch({
                        activeTab: "normal",
                        selectedPrId: lanePr.linkedPrId,
                        selectedQueueGroupId: null,
                        selectedRebaseItemId: null,
                      })}`);
                      return;
                    }
                    if (lanePr.githubUrl && isTrustedGitHubUrl(lanePr.githubUrl)) {
                      void window.ade?.app?.openExternal?.(lanePr.githubUrl);
                    }
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <GitPullRequest size={10} weight="bold" />
                  {formatPrBadgeLabel(lanePr)}
                </button>
              ) : null}
              {!isDeleting && devicesOpen.length > 0 ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 6px",
                    borderRadius: 6,
                    fontFamily: MONO_FONT,
                    fontSize: 9,
                    fontWeight: 700,
                    color: COLORS.accent,
                    background: COLORS.accentSubtle,
                    border: `1px solid ${COLORS.accentBorder}`,
                  }}
                  title={getDevicePresenceTitle(devicesOpen)}
                >
                  <UsersThree size={10} weight="bold" />
                  {devicesOpen.length}
                </span>
              ) : null}
              {/* Behind badge (rebase suggestion) */}
              {!isDeleting && rebaseSuggestion ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: 6,
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700,
                  color: COLORS.warning, background: "color-mix(in srgb, var(--color-warning) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
                }} title={`Behind ${rebaseSuggestion.baseLabel?.trim() || "base"} by ${rebaseSuggestion.behindCount} commit(s)`}>
                  ↑{rebaseSuggestion.behindCount}
                </span>
              ) : null}
              {/* Auto-rebase status badges */}
              {!isDeleting && autoRebaseStatus?.state === "autoRebased" ? (
                <span style={inlineBadge(COLORS.success, { fontSize: 9 })} title={autoRebaseStatus.message ?? "Lane was rebased automatically."}>
                  REBASED
                </span>
              ) : null}
              {!isDeleting && autoRebaseStatus?.state === "rebasePending" ? (
                <span style={inlineBadge(COLORS.warning, { fontSize: 9 })} title={autoRebaseStatus.message ?? "Auto-rebase is pending manual action."}>
                  PENDING
                </span>
              ) : null}
              {!isDeleting && autoRebaseStatus?.state === "rebaseFailed" ? (
                <span
                  style={inlineBadge(COLORS.danger, { fontSize: 9 })}
                  title={autoRebaseStatus.message ?? "Auto-rebase failed and the lane needs manual follow-up."}
                >
                  FAILED
                </span>
              ) : null}
              {!isDeleting && autoRebaseStatus?.state === "rebaseConflict" ? (
                <span
                  style={inlineBadge(COLORS.danger, { fontSize: 9 })}
                  title={autoRebaseStatus.message ?? "Auto-rebase stopped due to conflicts."}
                >
                  CONFLICT{autoRebaseStatus.conflictCount > 0 ? ` ${autoRebaseStatus.conflictCount}` : ""}
                </span>
              ) : null}
              {/* Pin toggle — appears on hover */}
              {!isDeleting && !isPrimary ? (
                <button
                  type="button"
                  className={`shrink-0 rounded transition-opacity ${isPinned ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                  style={{
                    display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center",
                    background: isPinned ? `color-mix(in srgb, ${COLORS.warning} 18%, transparent)` : "transparent",
                    color: COLORS.warning,
                    border: isPinned ? `1px solid color-mix(in srgb, ${COLORS.warning} 42%, transparent)` : "1px solid transparent",
                    cursor: "pointer",
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePinnedLane(lane.id);
                  }}
                  title={isPinned ? "Unpin lane" : "Pin lane"}
                >
                  <PushPin size={11} weight={isPinned ? "fill" : "regular"} />
                </button>
              ) : null}
              {/* Close from split — appears on hover */}
              {!isDeleting && closable ? (
                <button
                  type="button"
                  className="shrink-0 transition-opacity opacity-0 group-hover:opacity-100"
                  style={{
                    display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center",
                    background: "transparent", color: COLORS.textDim, border: "none", cursor: "pointer",
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeSplitLane(lane.id);
                  }}
                  title="Remove from split"
                >
                  <X size={10} />
                </button>
              ) : null}
              {isDeleting ? (
                <div
                  className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5"
                  style={{
                    background: "rgba(12, 15, 20, 0.72)",
                    color: COLORS.textSecondary,
                    fontFamily: MONO_FONT,
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.8px",
                    textTransform: "uppercase",
                  }}
                >
                  <CircleNotch size={12} className="animate-spin" />
                  <span>{getLaneDeleteStatusLabel(deleteProgress)}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Rebase / auto-rebase banners */}
      <LaneRebaseBanner
        visibleRebaseSuggestions={visibleRebaseSuggestions}
        visibleAutoRebaseNeedsAttention={visibleAutoRebaseNeedsAttention}
        lanesById={lanesById}
        rebaseSuggestionError={rebaseSuggestionError}
        onViewRebaseDetails={openRebaseDetails}
        onDismissRebase={(laneId) => { void dismissRebaseSuggestion(laneId); }}
        onDismissAutoRebase={(laneId) => { void dismissAutoRebaseStatus(laneId); }}
      />

      {/* Floating pane tiling layout */}
      {visibleLaneIds.length === 0 ? (
        <div className={lanesLoading && sortedLanes.length === 0 ? "flex-1 min-h-0 flex" : "flex-1 flex items-center justify-center"}>
          {sortedLanes.length === 0 ? (
            lanesLoading ? (
              <LaneLoadingSkeleton />
            ) : (
              <EmptyState
                title="No lanes created yet"
                description="Lanes let you work on multiple features in parallel."
              >
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canCreateLane}
                    onClick={() => {
                      prepareCreateDialog();
                    }}
                  >
                    Create Lane
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void useOnboardingStore.getState().startTour("lanes");
                    }}
                  >
                    Take the Lanes tour
                  </Button>
                </div>
              </EmptyState>
            )
          ) : (
            <EmptyState
              title={filteredLanes.length === 0 ? "No lanes match" : "No lane selected"}
              description={
                filteredLanes.length === 0
                  ? "Adjust the lane filter."
                  : "Select a lane tab to begin."
              }
            />
          )}
        </div>
      ) : visibleLaneIds.length === 1 ? (
        <PaneTilingLayout
          key={`lanes:single:${gridResetKey}`}
          layoutId={`lanes:tiling:${LANES_TILING_LAYOUT_VERSION}${laneTilingLayoutSuffix}:${visibleLaneIds[0]}`}
          tree={laneTilingTree}
          panes={getPaneConfigs(visibleLaneIds[0] ?? null)}
          className="flex-1 min-h-0"
        />
      ) : (
        <Group
          key={buildLaneSplitColumnsKey({ laneTilingLayoutSuffix, gridResetKey })}
          id="lanes-split-columns"
          orientation="horizontal"
          resizeTargetMinimumSize={RESIZE_TARGET_MINIMUM_SIZE}
          className="flex-1 min-h-0 min-w-0"
          onLayoutChanged={(nextLayout) => {
            const updates: Record<string, number> = {};
            for (const laneId of visibleLaneIds) {
              const panelId = `lane-column:${laneId}`;
              const size = nextLayout[panelId];
              if (typeof size === "number" && Number.isFinite(size)) {
                updates[panelId] = size;
              }
            }
            if (Object.keys(updates).length > 0) {
              saveLaneColumnLayout((prev) => ({ ...prev, ...updates }));
            }
          }}
        >
          {visibleLaneIds.map((laneId, index) => {
            const evenSize = Math.max(20, 100 / Math.max(1, visibleLaneIds.length));
            const savedColSize = laneColumnLayout[`lane-column:${laneId}`];
            const defaultSize = typeof savedColSize === "number" && Number.isFinite(savedColSize) ? savedColSize : evenSize;
            const lane = lanesById.get(laneId);
            const laneName = lane?.name ?? laneId.slice(0, 8);
            return (
              <Fragment key={laneId}>
                <Panel id={`lane-column:${laneId}`} minSize="12%" defaultSize={`${defaultSize}%`} className="min-h-0 min-w-0">
                  <div className="ade-lane-column" style={{ "--lane-accent": getLaneAccent(lane, index) } as React.CSSProperties}>
                    <div className="flex items-center gap-1.5 px-2 shrink-0" style={{ height: 22, background: `color-mix(in srgb, var(--lane-accent) 6%, transparent)` }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", color: "var(--lane-accent)", opacity: 0.85 }}>{laneName}</span>
                    </div>
                    <PaneTilingLayout
                      layoutId={`lanes:tiling:${LANES_TILING_LAYOUT_VERSION}${laneTilingLayoutSuffix}:${laneId}`}
                      tree={laneTilingTree}
                      panes={getPaneConfigs(laneId)}
                      className="flex-1 min-h-0"
                    />
                  </div>
                </Panel>
                {index < visibleLaneIds.length - 1 ? <ResizeGutter orientation="vertical" laneDivider /> : null}
              </Fragment>
            );
          })}
        </Group>
      )}

      {/* Fullscreen Git Actions pane overlay */}
      {expandedGitActionsLaneId && lanesById.has(expandedGitActionsLaneId) ? (
        <div className="fixed inset-0 z-[110] flex flex-col" style={{ background: COLORS.pageBg }}>
          <PaneTilingLayout
            layoutId={`lanes:git-actions:fullscreen:v1:${expandedGitActionsLaneId}`}
            tree={GIT_ACTIONS_FULLSCREEN_TREE}
            panes={getPaneConfigs(expandedGitActionsLaneId, "git-actions-fullscreen")}
            className="flex-1 min-h-0"
          />
        </div>
      ) : null}

      {/* Fullscreen lane overlay */}
      {expandedLaneId && lanesById.has(expandedLaneId) ? (
        <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: COLORS.pageBg }}>
          <div className="absolute top-2 right-3 z-10">
            <button
              type="button"
              style={outlineButton({ height: 28, padding: "0 8px" })}
              onClick={() => setExpandedLaneId(null)}
              title="Exit fullscreen (Esc)"
            >
              <X size={16} />
            </button>
          </div>
          <PaneTilingLayout
            layoutId={`lanes:tiling:${LANES_TILING_LAYOUT_VERSION}${laneTilingLayoutSuffix}:${expandedLaneId}`}
            tree={laneTilingTree}
            panes={getPaneConfigs(expandedLaneId, "lane-fullscreen")}
            className="flex-1 min-h-0"
          />
        </div>
      ) : null}

      {/* Lane tab context menu */}
      {laneContextMenu ? (
        <LaneContextMenu
          laneContextMenu={laneContextMenu}
          lanesById={lanesById}
          visibleLaneIds={visibleLaneIds}
          onClose={() => setLaneContextMenu(null)}
          onAdoptAttached={(laneId) => {
            reopenAdoptHint();
            requestAdoptAttachedLane(laneId);
          }}
          onManage={openManageDialog}
          onOpenRun={(laneId) => {
            selectLane(laneId);
            void navigate("/project");
          }}
          selectLane={selectLane}
          onRemoveFromSplit={removeSplitLane}
          onCloseOtherSplits={(keepLaneId) => {
            const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
            setActiveLaneIds(mergeUnique([keepLaneId], pinned));
            selectLane(keepLaneId);
          }}
          onSelectAll={() => {
            const allIds = filteredLanes.map((lane) => lane.id);
            setActiveLaneIds(allIds);
          }}
          onBatchManage={openBatchManage}
          onAppearanceChanged={() => refreshLanes({ includeStatus: false }).catch(() => {})}
        />
      ) : null}

      {/* Manage Lane dialog */}
      <ManageLaneDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        managedLane={managedLane}
        managedLanes={managedLanes}
        allLanes={lanes}
        deleteMode={deleteMode}
        setDeleteMode={setDeleteMode}
        deleteRemoteName={deleteRemoteName}
        setDeleteRemoteName={setDeleteRemoteName}
        deleteForce={deleteForce}
        setDeleteForce={setDeleteForce}
        deleteConfirmText={deleteConfirmText}
        setDeleteConfirmText={setDeleteConfirmText}
        deletePhrase={deletePhrase}
        laneActionBusy={laneActionBusy}
        laneActionStatus={laneActionStatus}
        laneActionError={laneActionError}
        laneActionKind={laneActionKind}
        onAdoptAttached={() => {
          if (!managedLane || managedLane.laneType !== "attached") return;
          reopenAdoptHint();
          requestAdoptAttachedLane(managedLane.id);
        }}
        onArchive={() => { archiveManagedLanes().catch(() => {}); }}
        onDelete={() => { deleteManagedLanes().catch(() => {}); }}
        onAppearanceChanged={() => refreshLanes({ includeStatus: false }).catch(() => {})}
        onStackReorganized={() => { refreshLanes().catch(() => {}); }}
      />



      {/* Create Lane dialog */}
      <CreateLaneDialog
        open={createOpen}
        onOpenChange={handleCreateDialogOpenChange}
        createLaneName={createLaneName}
        setCreateLaneName={setCreateLaneName}
        createMode={createMode}
        setCreateMode={setCreateMode}
        createParentLaneId={createParentLaneId}
        setCreateParentLaneId={setCreateParentLaneId}
        createBaseBranch={createBaseBranch}
        setCreateBaseBranch={handleSetCreateBaseBranch}
        createImportBranch={createImportBranch}
        setCreateImportBranch={setCreateImportBranch}
        createChildBaseBranch={createChildBaseBranch}
        setCreateChildBaseBranch={setCreateChildBaseBranch}
        runtimePlacement={createRuntimePlacement}
        setRuntimePlacement={setCreateRuntimePlacement}
        vmRuntimeAvailable={createVmRuntimeAvailable}
        vmRuntimeUnavailableReason={createVmRuntimeUnavailableReason}
        vmRuntimeGateKind={createVmRuntimeAvailable
          ? "none"
          : reservedVmLane
            ? "existing-vm-lane"
            : "vm-setup"}
        existingVmLane={reservedVmLane}
        onOpenVmTab={() => navigate("/vm")}
        onOpenVmLaneInWork={(laneId) => {
          selectLane(laneId);
          // The rest of this file opens the Work surface via "/project" (see
          // the lane context-menu onOpenRun handler above). Navigating to
          // "/work" here would land on the legacy Work route which is no
          // longer the canonical destination for opening a lane.
          navigate("/project");
        }}
        createBranches={createBranches}
        lanes={lanes}
        onSubmit={handleCreateSubmit}
        busy={createBusy}
        error={createError}
        envInitProgress={createEnvInitProgress}
        laneCreated={laneCreated}
        setupStatus={createSetupStatus}
        setupSteps={createSetupSteps}
        templates={templates}
        selectedTemplateId={selectedTemplateId}
        setSelectedTemplateId={setSelectedTemplateId}
        selectedColor={createSelectedColor}
        setSelectedColor={setCreateSelectedColor}
        selectedLinearIssue={createSelectedLinearIssue}
        setSelectedLinearIssue={handleSetCreateLinearIssue}
        branchPullRequests={createBranchPullRequests}
        currentGitUserName={createGitUserName}
        loadingBranches={createBranchesLoading}
        loadingBranchPullRequests={createBranchPullRequestsLoading}
        onNavigateToTemplates={() => navigate("/settings?tab=lane-templates")}
        importBranchWarning={
          createMode === "existing" && createImportBranch && primaryLane?.status.dirty
            && createBranches.find((b) => b.name === createImportBranch && !b.isRemote)?.isCurrent
            ? `This branch is currently checked out and has uncommitted changes. The new lane will only include committed changes\u2009—\u2009uncommitted work will not carry over.`
            : null
        }
      />

      {/* Attach Lane dialog */}
      <AttachLaneDialog
        open={attachOpen}
        onOpenChange={(open) => {
          setAttachOpen(open);
          if (!open) {
            setAttachBusy(false);
            setAttachError(null);
          }
        }}
        attachName={attachName}
        setAttachName={setAttachName}
        attachPath={attachPath}
        setAttachPath={setAttachPath}
        attachDescription={attachDescription}
        setAttachDescription={setAttachDescription}
        busy={attachBusy}
        error={attachError}
        onSubmit={handleAttachSubmit}
      />

      <MultiAttachWorktreeDialog
        open={multiAttachOpen}
        onOpenChange={setMultiAttachOpen}
        onFallbackToManual={() => {
          setMultiAttachOpen(false);
          setAttachName("");
          setAttachPath("");
          setAttachDescription("");
          setAttachBusy(false);
          setAttachError(null);
          setAttachOpen(true);
        }}
        onComplete={() => {
          void refreshLanes().catch(() => {});
        }}
      />

      {adoptConfirmOpen ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(620px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
            <div style={{ ...LABEL_STYLE, color: COLORS.info }}>MOVE ATTACHED LANE</div>
            <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
              Move <strong>{adoptTargetLane?.name ?? "this lane"}</strong> into <code>.ade/worktrees</code>.
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
              ADE uses <code>git worktree move</code>, so branch history and commits stay exactly the same.
            </div>
            {adoptTargetLane ? (
              <div style={{ marginTop: 10, padding: "8px 10px", background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 12 }}>
                <div style={{ fontSize: 11, color: COLORS.textSecondary }}>Current path</div>
                <div className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                  {adoptTargetLane.worktreePath}
                </div>
              </div>
            ) : null}
            {adoptError ? (
              <div style={{ marginTop: 10, padding: "8px 10px", background: "color-mix(in srgb, var(--color-error) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--color-error) 40%, transparent)", borderRadius: 8, color: "#FCA5A5", fontSize: 12 }}>
                {adoptError}
              </div>
            ) : null}
            <div className="flex justify-end gap-2" style={{ marginTop: 12 }}>
              <button
                type="button"
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                disabled={adoptBusy}
                onClick={() => {
                  setAdoptConfirmOpen(false);
                  setAdoptTargetLaneId(null);
                  setAdoptError(null);
                }}
              >
                CANCEL
              </button>
              <button
                type="button"
                style={primaryButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                disabled={adoptBusy || !adoptTargetLane}
                onClick={() => { void confirmAdoptAttachedLane(); }}
              >
                {adoptBusy ? "MOVING..." : "MOVE TO .ADE"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rebaseScopePrompt ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(520px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
            <div style={{ ...LABEL_STYLE, color: COLORS.accent }}>REBASE SCOPE</div>
            <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
              Choose how to rebase <strong>{rebaseScopePrompt.laneName}</strong>.
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                style={outlineButton({ height: 34, padding: "0 10px", fontSize: 11 })}
                onClick={() => {
                  rebaseScopePrompt.resolve("lane_only");
                  setRebaseScopePrompt(null);
                }}
              >
                CURRENT LANE ONLY
              </button>
              <button
                type="button"
                style={primaryButton({ height: 34, padding: "0 10px", fontSize: 11 })}
                onClick={() => {
                  rebaseScopePrompt.resolve("lane_and_descendants");
                  setRebaseScopePrompt(null);
                }}
              >
                LANE + CHILDREN
              </button>
            </div>
            <div className="flex justify-end" style={{ marginTop: 12 }}>
              <button
                type="button"
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                onClick={() => {
                  rebaseScopePrompt.resolve(null);
                  setRebaseScopePrompt(null);
                }}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rebasePushReview ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(620px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
            <div style={{ ...LABEL_STYLE, color: COLORS.accent }}>REVIEW THEN PUSH</div>
            <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
              Select rebased lanes to push to remote.
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 240, overflowY: "auto" }}>
              {rebasePushReview.lanes.map((lane) => (
                <label
                  key={lane.laneId}
                  className="flex items-center gap-2"
                  style={{ fontSize: 12, color: COLORS.textSecondary, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 10px" }}
                >
                  <input
                    type="checkbox"
                    checked={lane.selected}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setRebasePushReview((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          lanes: prev.lanes.map((entry) => entry.laneId === lane.laneId ? { ...entry, selected: checked } : entry)
                        };
                      });
                    }}
                  />
                  <span className="truncate">{lane.laneName}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2" style={{ marginTop: 12 }}>
              <button
                type="button"
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                onClick={() => {
                  rebasePushReview.resolve(null);
                  setRebasePushReview(null);
                }}
              >
                CANCEL
              </button>
              <button
                type="button"
                style={primaryButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                onClick={() => {
                  const laneIds = rebasePushReview.lanes.filter((lane) => lane.selected).map((lane) => lane.laneId);
                  rebasePushReview.resolve(laneIds);
                  setRebasePushReview(null);
                }}
              >
                PUSH SELECTED
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
