import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowsClockwise, CaretDown, CaretRight, Check, Folder, Stack, Trash, Upload, Warning } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { getProjectConfigCached } from "../../lib/projectConfigCache";
import { modifierKeyLabel } from "../../lib/platform";
import { cn } from "../ui/cn";
import { BranchIcon } from "../ui/vcsIcons";
import { SmartTooltip, type SmartTooltipContent } from "../ui/SmartTooltip";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, outlineButton, primaryButton, dangerButton } from "./laneDesignTokens";
import { CommitTimeline } from "./CommitTimeline";
import { LaneDiffPane } from "./LaneDiffPane";
import { LinearIssueBadge } from "./LinearIssueBadge";
import type {
  DiffChanges,
  FileChange,
  GitCommitSummary,
  GitConflictState,
  GitRecommendedAction,
  GitStashSummary,
  GitSyncMode,
  GitUpstreamSyncStatus,
  AutoRebaseLaneStatus,
  LaneSummary
} from "../../../shared/types";

type LaneTextPromptState = {
  title: string;
  message?: string;
  placeholder?: string;
  value: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

type NextActionHint = {
  action: GitRecommendedAction | "rebase_push" | "resolve_conflicts";
  label: string;
  detail: string;
};

type CommitMessageAiState = {
  enabled: boolean;
  modelId: string | null;
};

type ResponsiveMode = "narrow" | "medium" | "wide";

const AUTO_GENERATE_COMMIT_ACTION = "generate commit message";
const MAX_RENDERED_CHANGE_ROWS_PER_SECTION = 300;
type LaneGitActionRuntimeState = {
  version: number;
  busyAction: string | null;
  notice: string | null;
  error: string | null;
};

const EMPTY_LANE_GIT_ACTION_RUNTIME_STATE: LaneGitActionRuntimeState = {
  version: 0,
  busyAction: null,
  notice: null,
  error: null,
};

const laneGitActionRuntimeByLaneId = new Map<string, LaneGitActionRuntimeState>();
const laneGitActionRuntimeListeners = new Set<() => void>();

type LaneGitActionsCachedState = {
  changes: DiffChanges;
  stashes: GitStashSummary[];
  syncStatus: GitUpstreamSyncStatus | null;
  forcePushSuggested: boolean;
  autoRebaseStatus: AutoRebaseLaneStatus | null;
  conflictState: GitConflictState | null;
  stuckRebase: GitConflictState | null;
  updatedAtMs: number;
};

const EMPTY_CHANGES: DiffChanges = { unstaged: [], staged: [] };
const MAX_LANE_GIT_ACTIONS_CACHE_ENTRIES = 96;
const laneGitActionsStateByScope = new Map<string, LaneGitActionsCachedState>();

function laneGitActionsStateKey(projectRoot: string | null | undefined, laneId: string | null): string | null {
  if (!laneId) return null;
  return `${projectRoot?.trim() || "__project__"}::${laneId}`;
}

function readLaneGitActionsCachedState(
  projectRoot: string | null | undefined,
  laneId: string | null,
): LaneGitActionsCachedState | null {
  const key = laneGitActionsStateKey(projectRoot, laneId);
  if (!key) return null;
  const cached = laneGitActionsStateByScope.get(key) ?? null;
  if (!cached) return null;
  laneGitActionsStateByScope.delete(key);
  laneGitActionsStateByScope.set(key, cached);
  return cached;
}

function patchLaneGitActionsCachedState(
  projectRoot: string | null | undefined,
  laneId: string | null,
  patch: Partial<Omit<LaneGitActionsCachedState, "updatedAtMs">>,
): LaneGitActionsCachedState | null {
  const key = laneGitActionsStateKey(projectRoot, laneId);
  if (!key) return null;
  const previous = laneGitActionsStateByScope.get(key);
  const next: LaneGitActionsCachedState = {
    changes: previous?.changes ?? EMPTY_CHANGES,
    stashes: previous?.stashes ?? [],
    syncStatus: previous?.syncStatus ?? null,
    forcePushSuggested: previous?.forcePushSuggested ?? false,
    autoRebaseStatus: previous?.autoRebaseStatus ?? null,
    conflictState: previous?.conflictState ?? null,
    stuckRebase: previous?.stuckRebase ?? null,
    ...patch,
    updatedAtMs: Date.now(),
  };
  laneGitActionsStateByScope.delete(key);
  laneGitActionsStateByScope.set(key, next);
  while (laneGitActionsStateByScope.size > MAX_LANE_GIT_ACTIONS_CACHE_ENTRIES) {
    const oldest = laneGitActionsStateByScope.keys().next().value;
    if (!oldest) break;
    laneGitActionsStateByScope.delete(oldest);
  }
  return next;
}

function emitLaneGitActionRuntimeChange(): void {
  for (const listener of laneGitActionRuntimeListeners) {
    listener();
  }
}

function readLaneGitActionRuntimeState(laneId: string | null): LaneGitActionRuntimeState {
  if (!laneId) return EMPTY_LANE_GIT_ACTION_RUNTIME_STATE;
  return laneGitActionRuntimeByLaneId.get(laneId) ?? EMPTY_LANE_GIT_ACTION_RUNTIME_STATE;
}

function writeLaneGitActionRuntimeState(
  laneId: string | null,
  next: LaneGitActionRuntimeState,
): LaneGitActionRuntimeState {
  if (!laneId) return EMPTY_LANE_GIT_ACTION_RUNTIME_STATE;
  if (!next.busyAction && !next.notice && !next.error) {
    laneGitActionRuntimeByLaneId.delete(laneId);
  } else {
    laneGitActionRuntimeByLaneId.set(laneId, next);
  }
  emitLaneGitActionRuntimeChange();
  return next;
}

function patchLaneGitActionRuntimeState(
  laneId: string | null,
  patch: Partial<LaneGitActionRuntimeState>,
): LaneGitActionRuntimeState {
  const prev = readLaneGitActionRuntimeState(laneId);
  return writeLaneGitActionRuntimeState(laneId, { ...prev, ...patch });
}

function beginLaneGitActionRuntime(
  laneId: string | null,
  patch: Pick<LaneGitActionRuntimeState, "busyAction" | "notice" | "error">,
): number {
  const nextVersion = readLaneGitActionRuntimeState(laneId).version + 1;
  writeLaneGitActionRuntimeState(laneId, { ...patch, version: nextVersion });
  return nextVersion;
}

function patchLaneGitActionRuntimeStateIfCurrent(
  laneId: string | null,
  version: number,
  patch: Partial<LaneGitActionRuntimeState>,
): LaneGitActionRuntimeState {
  const current = readLaneGitActionRuntimeState(laneId);
  if (current.version !== version) return current;
  return writeLaneGitActionRuntimeState(laneId, { ...current, ...patch, version });
}

function scheduleLaneGitActionRuntimeClear(
  laneId: string | null,
  version: number,
  delayMs: number,
  patch: Partial<LaneGitActionRuntimeState>,
): void {
  window.setTimeout(() => {
    patchLaneGitActionRuntimeStateIfCurrent(laneId, version, patch);
  }, delayMs);
}

function useLaneGitActionRuntimeState(laneId: string | null): LaneGitActionRuntimeState {
  return React.useSyncExternalStore(
    (listener) => {
      laneGitActionRuntimeListeners.add(listener);
      return () => {
        laneGitActionRuntimeListeners.delete(listener);
      };
    },
    () => readLaneGitActionRuntimeState(laneId),
    () => EMPTY_LANE_GIT_ACTION_RUNTIME_STATE,
  );
}

export {
  beginLaneGitActionRuntime,
  patchLaneGitActionRuntimeStateIfCurrent,
  scheduleLaneGitActionRuntimeClear,
  useLaneGitActionRuntimeState,
};

export function __resetLaneGitActionRuntimeForTests(): void {
  laneGitActionRuntimeByLaneId.clear();
  emitLaneGitActionRuntimeChange();
}

function formatRelativeTime(ts: string | null): string {
  if (!ts) return "unknown time";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function getResponsiveMode(width: number): ResponsiveMode {
  if (width < 640) return "narrow";
  if (width < 900) return "medium";
  return "wide";
}

function getLaneHeaderDotColor(lane: LaneSummary | null): string {
  if (!lane) return "#10B981";
  if (lane.laneType === "primary") return COLORS.accent;
  return lane.status.dirty ? COLORS.warning : "#10B981";
}

function getLaneHeaderDotTitle(lane: LaneSummary | null): string {
  if (lane?.laneType === "primary") return "Primary lane";
  if (lane?.status.dirty) return "Lane has uncommitted changes";
  return "Lane is clean";
}

function getFileKindColor(kind: FileChange["kind"]): string {
  if (kind === "modified") return COLORS.info;
  if (kind === "added") return COLORS.success;
  if (kind === "deleted") return COLORS.danger;
  return COLORS.warning;
}

type ChangeTreeNode = {
  name: string;
  path: string;
  dirs: Map<string, ChangeTreeNode>;
  files: FileChange[];
};

type ChangeTreeStats = {
  files: number;
  additions: number;
  deletions: number;
};

function createChangeTreeNode(name: string, path: string): ChangeTreeNode {
  return { name, path, dirs: new Map(), files: [] };
}

function buildChangeTree(files: FileChange[]): ChangeTreeNode {
  const root = createChangeTreeNode("", "");
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const nextPath = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = createChangeTreeNode(part, nextPath);
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

function getChangeTreeStats(node: ChangeTreeNode, statsByPath?: Map<string, ChangeTreeStats>): ChangeTreeStats {
  let files = node.files.length;
  let additions = node.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  let deletions = node.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  for (const child of node.dirs.values()) {
    const stats = getChangeTreeStats(child, statsByPath);
    files += stats.files;
    additions += stats.additions;
    deletions += stats.deletions;
  }
  const stats = { files, additions, deletions };
  if (node.path) statsByPath?.set(node.path, stats);
  return stats;
}

function buildChangeTreeStatsByPath(files: FileChange[]): Map<string, ChangeTreeStats> {
  const statsByPath = new Map<string, ChangeTreeStats>();
  getChangeTreeStats(buildChangeTree(files), statsByPath);
  return statsByPath;
}

function getCommitButtonLabel(args: {
  busyAction: string | null;
  amendCommit: boolean;
}): string {
  if (args.busyAction === AUTO_GENERATE_COMMIT_ACTION) {
    return "GENERATING...";
  }
  const commitActionLabel = args.amendCommit ? "amend commit" : "commit";
  if (args.busyAction === commitActionLabel) {
    return "COMMITTING...";
  }
  return args.amendCommit ? "AMEND COMMIT" : "COMMIT";
}

function getCommitHelperText(args: {
  commitMessage: string;
  commitMessageAi: CommitMessageAiState;
}): string {
  if (args.commitMessage.trim().length > 0) {
    return `Press ${modifierKeyLabel}+Enter to commit with the typed message.`;
  }
  if (args.commitMessageAi.enabled && args.commitMessageAi.modelId) {
    return `Blank messages will be auto-generated with ${args.commitMessageAi.modelId}.`;
  }
  if (args.commitMessageAi.enabled) {
    return "Commit Messages is enabled, but no model is selected in Settings.";
  }
  return "Type a commit message, or enable Commit Messages in Settings to auto-generate one when blank.";
}

function getAutoRebaseBannerConfig(state: AutoRebaseLaneStatus["state"]): {
  color: string;
  label: string;
  fallbackMessage: string;
} {
  if (state === "autoRebased") {
    return {
      color: COLORS.success,
      label: "AUTO REBASED",
      fallbackMessage: "Lane was rebased and pushed automatically."
    };
  }
  if (state === "rebaseConflict" || state === "rebaseFailed") {
    return {
      color: COLORS.danger,
      label: "AUTO-REBASE FAILED",
      fallbackMessage: state === "rebaseConflict"
        ? "ADE predicted conflicts for this lane and stopped before rewriting or pushing it."
        : "ADE tried to auto-rebase this lane, restored the previous state, and stopped before pushing changes."
    };
  }
  return {
    color: COLORS.warning,
    label: "AUTO-REBASE PENDING",
    fallbackMessage: "ADE will auto-rebase and auto-push this lane when its parent advances."
  };
}

function getPullModeSummary(mode: GitSyncMode): string {
  return mode === "merge"
    ? "Merge keeps both histories and may create a merge commit."
    : "Rebase replays your local commits on top of the remote branch for a cleaner history.";
}

function getAmendSummary(amendCommit: boolean): string {
  return amendCommit
    ? "Amend is on. Your next commit will replace the latest commit instead of creating a new one."
    : "Amend rewrites the latest commit with your staged changes and optional new message.";
}

function SectionCard({
  title,
  description,
  aside,
  children,
  dataTestId,
  showDescription = false,
  sectionStyle,
  headerStyle,
  bodyStyle,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  dataTestId?: string;
  showDescription?: boolean;
  sectionStyle?: React.CSSProperties;
  headerStyle?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <section
      data-testid={dataTestId}
      title={!showDescription ? description : undefined}
      style={{
        border: `1px solid ${COLORS.border}`,
        background: COLORS.cardBg,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        ...sectionStyle,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 10px",
          borderBottom: `1px solid ${COLORS.border}`,
          background: COLORS.recessedBg,
          ...headerStyle,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ ...LABEL_STYLE, color: COLORS.textPrimary }}>{title}</div>
          {description && showDescription ? (
            <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: COLORS.textMuted }}>
              {description}
            </div>
          ) : null}
        </div>
        {aside ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{aside}</div> : null}
      </div>
      <div
        style={{
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minWidth: 0,
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function HoverTitleButton({
  tooltip,
  smartTooltip,
  disabled,
  style,
  children,
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip: string;
  smartTooltip?: SmartTooltipContent;
}) {
  const button = (
    <button
      {...buttonProps}
      disabled={disabled}
      title={tooltip}
      style={{
        ...style,
        ...(disabled ? { pointerEvents: "none" as const } : {}),
      }}
    >
      {children}
    </button>
  );

  const wrapped = !disabled ? button : (
    <span title={tooltip} style={{ display: "inline-flex" }}>
      {button}
    </span>
  );

  if (smartTooltip) {
    return <SmartTooltip content={smartTooltip}>{wrapped}</SmartTooltip>;
  }
  return wrapped;
}

function ActionButton({
  title,
  detail,
  onClick,
  disabled,
  emphasis = "secondary",
  badge,
  icon,
  fullWidth = false,
  smartTooltip,
}: {
  title: string;
  detail: string;
  onClick: () => void;
  disabled: boolean;
  emphasis?: "primary" | "secondary";
  badge?: string | null;
  icon?: React.ReactNode;
  fullWidth?: boolean;
  smartTooltip?: SmartTooltipContent;
}) {
  const primary = emphasis === "primary";
  return (
    <HoverTitleButton
      type="button"
      disabled={disabled}
      onClick={onClick}
      tooltip={`${title}. ${detail}`}
      smartTooltip={smartTooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: fullWidth ? "100%" : "auto",
        minWidth: 0,
        height: 34,
        padding: "0 10px",
        border: primary ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.outlineBorder}`,
        background: primary ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent",
        color: primary ? COLORS.textPrimary : COLORS.textSecondary,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {icon ? <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}>{icon}</span> : null}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            letterSpacing: "0.7px",
            textTransform: "uppercase",
            minWidth: 0,
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
      </div>
      {badge ? <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{badge}</span> : null}
    </HoverTitleButton>
  );
}

export function LaneGitActionsPane({
  laneId,
  autoRebaseEnabled,
  autoRebaseStatusSnapshot,
  onOpenSettings,
  onRebaseNowLocal,
  onRebaseAndPush,
  onViewRebaseDetails,
  onResolveRebaseConflict,
  onSelectFile,
  onSelectCommit,
  onClearDiffSelection,
  selectedPath,
  selectedMode,
  selectedCommit = null,
  selectedCommitSha
}: {
  laneId: string | null;
  autoRebaseEnabled: boolean;
  autoRebaseStatusSnapshot?: AutoRebaseLaneStatus | null;
  onOpenSettings: () => void;
  onRebaseNowLocal?: (laneId: string) => Promise<void> | void;
  onRebaseAndPush?: (laneId: string) => Promise<void> | void;
  onViewRebaseDetails?: (laneId?: string | null) => void;
  onResolveRebaseConflict?: (laneId: string, parentLaneId: string | null) => void;
  onSelectFile: (path: string, mode: "staged" | "unstaged") => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  /** Clears file + commit diff selection (back to file list in this section). */
  onClearDiffSelection?: () => void;
  selectedPath: string | null;
  selectedMode: "staged" | "unstaged" | null;
  /** Defaults to null when omitted (e.g. floating pane / legacy call sites). */
  selectedCommit?: GitCommitSummary | null;
  selectedCommitSha: string | null;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);

  const lane = useMemo(() => lanes.find((entry) => entry.id === laneId) ?? null, [lanes, laneId]);
  const parentLane = useMemo(() => {
    if (!lane?.parentLaneId) return null;
    return lanes.find((entry) => entry.id === lane.parentLaneId) ?? null;
  }, [lanes, lane]);

  const originLabel = useMemo(() => {
    if (!lane || lane.laneType === "primary") return null;
    if (parentLane) return `from ${parentLane.name}/${parentLane.branchRef}`;
    return `from primary/${lane.baseRef}`;
  }, [lane, parentLane]);

  const rootRef = useRef<HTMLDivElement>(null);
  const currentLaneIdRef = useRef<string | null>(laneId);
  const [paneWidth, setPaneWidth] = useState(1024);
  const initialCachedGitState = readLaneGitActionsCachedState(projectRoot, laneId);

  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>(initialCachedGitState?.changes ?? EMPTY_CHANGES);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageAi, setCommitMessageAi] = useState<CommitMessageAiState>({ enabled: false, modelId: null });
  const [syncMode, setSyncMode] = useState<GitSyncMode>("merge");
  const [stashes, setStashes] = useState<GitStashSummary[]>(initialCachedGitState?.stashes ?? []);
  const [syncStatus, setSyncStatus] = useState<GitUpstreamSyncStatus | null>(initialCachedGitState?.syncStatus ?? null);
  const [forcePushSuggested, setForcePushSuggested] = useState(initialCachedGitState?.forcePushSuggested ?? false);
  const [textPrompt, setTextPrompt] = useState<LaneTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);
  const [commitTimelineKey, setCommitTimelineKey] = useState(0);
  const [amendCommit, setAmendCommit] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoRebaseStatus, setAutoRebaseStatus] = useState<AutoRebaseLaneStatus | null>(
    autoRebaseStatusSnapshot ?? initialCachedGitState?.autoRebaseStatus ?? null,
  );
  const autoRebaseStatusSnapshotRef = useRef<AutoRebaseLaneStatus | null | undefined>(autoRebaseStatusSnapshot);
  const [conflictState, setConflictState] = useState<GitConflictState | null>(initialCachedGitState?.conflictState ?? null);
  const [stuckRebase, setStuckRebase] = useState<GitConflictState | null>(initialCachedGitState?.stuckRebase ?? null);
  const laneGitActionRuntime = useLaneGitActionRuntimeState(laneId);
  const busyAction = laneGitActionRuntime.busyAction;
  const notice = laneGitActionRuntime.notice;
  const error = laneGitActionRuntime.error;

  const stagedCount = changes.staged.length;
  const hasStaged = stagedCount > 0;
  const hasUnstaged = changes.unstaged.length > 0;
  const hasUntrackedChanges = changes.unstaged.some((file) => file.kind === "untracked");
  const [showAllStagedChanges, setShowAllStagedChanges] = useState(false);
  const [showAllUnstagedChanges, setShowAllUnstagedChanges] = useState(false);
  const [collapsedChangeFolders, setCollapsedChangeFolders] = useState<Set<string>>(() => new Set());
  const visibleStagedChanges = useMemo(
    () => (showAllStagedChanges ? changes.staged : changes.staged.slice(0, MAX_RENDERED_CHANGE_ROWS_PER_SECTION)),
    [changes.staged, showAllStagedChanges],
  );
  const visibleUnstagedChanges = useMemo(
    () => (showAllUnstagedChanges ? changes.unstaged : changes.unstaged.slice(0, MAX_RENDERED_CHANGE_ROWS_PER_SECTION)),
    [changes.unstaged, showAllUnstagedChanges],
  );
  const stagedChangeTreeStatsByPath = useMemo(() => buildChangeTreeStatsByPath(changes.staged), [changes.staged]);
  const unstagedChangeTreeStatsByPath = useMemo(() => buildChangeTreeStatsByPath(changes.unstaged), [changes.unstaged]);
  const hiddenStagedChangeCount = Math.max(0, changes.staged.length - visibleStagedChanges.length);
  const hiddenUnstagedChangeCount = Math.max(0, changes.unstaged.length - visibleUnstagedChanges.length);
  const responsiveMode = getResponsiveMode(paneWidth);
  const maxVisibleStashes = responsiveMode === "wide" ? 2 : 3;
  currentLaneIdRef.current = laneId;

  const isViewingLane = useCallback((targetLaneId: string | null) => currentLaneIdRef.current === targetLaneId, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      setPaneWidth(rootRef.current?.clientWidth ?? window.innerWidth);
      return;
    }
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      if (width > 0) setPaneWidth(width);
    });
    observer.observe(node);
    setPaneWidth(node.clientWidth || window.innerWidth);
    return () => observer.disconnect();
  }, []);

  const requestTextInput = useCallback(
    (args: {
      title: string;
      message?: string;
      placeholder?: string;
      defaultValue?: string;
      confirmLabel?: string;
      validate?: (value: string) => string | null;
    }): Promise<string | null> => {
      return new Promise((resolve) => {
        setTextPromptError(null);
        setTextPrompt({
          title: args.title,
          message: args.message,
          placeholder: args.placeholder,
          value: args.defaultValue ?? "",
          confirmLabel: args.confirmLabel ?? "Confirm",
          validate: args.validate,
          resolve
        });
      });
    },
    []
  );

  const cancelTextPrompt = useCallback(() => {
    setTextPrompt((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
    setTextPromptError(null);
  }, []);

  const submitTextPrompt = useCallback(() => {
    setTextPrompt((prev) => {
      if (!prev) return prev;
      const value = prev.value.trim();
      const validationError = prev.validate?.(value) ?? null;
      if (validationError) {
        setTextPromptError(validationError);
        return prev;
      }
      setTextPromptError(null);
      prev.resolve(value);
      return null;
    });
  }, []);

  const refreshChanges = async (targetLaneId: string | null = laneId) => {
    if (!targetLaneId) return;
    const hasCachedState = Boolean(readLaneGitActionsCachedState(projectRoot, targetLaneId));
    if (isViewingLane(targetLaneId) && !hasCachedState) setLoading(true);
    try {
      const next = await window.ade.diff.getChanges({ laneId: targetLaneId });
      patchLaneGitActionsCachedState(projectRoot, targetLaneId, { changes: next });
      if (isViewingLane(targetLaneId)) {
        setChanges(next);
      }
    } finally {
      if (isViewingLane(targetLaneId) && !hasCachedState) {
        setLoading(false);
      }
    }
  };

  const refreshGitMeta = async (targetLaneId: string | null = laneId) => {
    if (!targetLaneId) return;
    const [stashesResult, syncStatusResult, conflictResult] = await Promise.allSettled([
      window.ade.git.stashList({ laneId: targetLaneId }),
      window.ade.git.getSyncStatus({ laneId: targetLaneId }),
      window.ade.git.getConflictState(targetLaneId)
    ]);

    const stashes = stashesResult.status === "fulfilled" ? stashesResult.value : undefined;
    const nextSyncStatus = syncStatusResult.status === "fulfilled" ? syncStatusResult.value : null;
    const nextConflictState = conflictResult.status === "fulfilled" ? conflictResult.value : null;
    patchLaneGitActionsCachedState(projectRoot, targetLaneId, {
      ...(stashes ? { stashes } : {}),
      syncStatus: nextSyncStatus,
      conflictState: nextConflictState,
      stuckRebase: nextConflictState?.kind === "rebase" && nextConflictState.inProgress ? nextConflictState : null,
    });

    if (!isViewingLane(targetLaneId)) return;

    if (stashesResult.status === "fulfilled") setStashes(stashesResult.value);
    setSyncStatus(syncStatusResult.status === "fulfilled" ? syncStatusResult.value : null);
    const cs = conflictResult.status === "fulfilled" ? conflictResult.value : null;
    setConflictState(cs);
    setStuckRebase(cs?.kind === "rebase" && cs.inProgress ? cs : null);
  };

  const refreshLaneGitState = useCallback(async (targetLaneId: string | null) => {
    await Promise.all([
      refreshChanges(targetLaneId),
      refreshLanes({ includeStatus: true, includeSnapshots: false }),
      refreshGitMeta(targetLaneId),
    ]);
  }, [refreshChanges, refreshGitMeta, refreshLanes]);

  const refreshAll = async (options?: { fetchRemote?: boolean }, targetLaneId: string | null = laneId) => {
    if (targetLaneId && options?.fetchRemote) {
      try {
        await window.ade.git.fetch({ laneId: targetLaneId });
      } catch {
        // best effort
      }
    }
    await refreshLaneGitState(targetLaneId);
    if (isViewingLane(targetLaneId)) {
      setCommitTimelineKey((prev) => prev + 1);
    }
  };

  const refreshAutoRebaseStatus = useCallback(async (targetLaneId: string | null = laneId) => {
    if (!targetLaneId) {
      if (isViewingLane(targetLaneId)) {
        setAutoRebaseStatus(null);
      }
      return;
    }
    try {
      const statuses = await window.ade.lanes.listAutoRebaseStatuses();
      const nextStatus = statuses.find((entry) => entry.laneId === targetLaneId) ?? null;
      patchLaneGitActionsCachedState(projectRoot, targetLaneId, { autoRebaseStatus: nextStatus });
      if (isViewingLane(targetLaneId)) {
        setAutoRebaseStatus(nextStatus);
      }
    } catch {
      if (isViewingLane(targetLaneId)) {
        setAutoRebaseStatus(null);
      }
    }
  }, [isViewingLane, laneId, projectRoot]);

  const refreshCommitMessageAiState = useCallback(async () => {
    try {
      const snapshot = await getProjectConfigCached({ projectRoot });
      const effectiveAi = snapshot.effective?.ai;
      const features = effectiveAi && typeof effectiveAi === "object" && "features" in effectiveAi
        ? (effectiveAi.features as Record<string, unknown> | undefined)
        : undefined;
      const featureModelOverrides = effectiveAi && typeof effectiveAi === "object" && "featureModelOverrides" in effectiveAi
        ? (effectiveAi.featureModelOverrides as Record<string, unknown> | undefined)
        : undefined;
      const enabled = features?.commit_messages === true;
      const modelIdRaw = typeof featureModelOverrides?.commit_messages === "string"
        ? featureModelOverrides.commit_messages.trim()
        : "";
      setCommitMessageAi({
        enabled,
        modelId: modelIdRaw.length ? modelIdRaw : null,
      });
    } catch {
      setCommitMessageAi({ enabled: false, modelId: null });
    }
  }, [projectRoot]);

  useEffect(() => {
    autoRebaseStatusSnapshotRef.current = autoRebaseStatusSnapshot;
    if (autoRebaseStatusSnapshot !== undefined) {
      setAutoRebaseStatus(autoRebaseStatusSnapshot);
    }
  }, [autoRebaseStatusSnapshot]);

  const isNonFastForwardError = useCallback((rawMessage: string): boolean => {
    const lower = rawMessage.toLowerCase();
    return lower.includes("non-fast-forward") || lower.includes("failed to push some refs");
  }, []);

  const formatActionError = useCallback((actionName: string, rawMessage: string): string => {
    if ((actionName === "push" || actionName === "force push") && isNonFastForwardError(rawMessage)) {
      return "Push rejected because remote history changed. Use Force Push (lease) after a rebase, amend, or other rewritten history.";
    }
    return rawMessage;
  }, [isNonFastForwardError]);

  const runAction = async (actionName: string, fn: () => Promise<void>) => {
    const actionLaneId = laneId;
    if (!actionLaneId) return;
    const actionVersion = beginLaneGitActionRuntime(actionLaneId, {
      busyAction: actionName,
      notice: null,
      error: null,
    });
    try {
      await fn();
      const isRemoteAction =
        actionName === "pull" ||
        actionName === "fetch" ||
        actionName === "push" ||
        actionName === "force push" ||
        actionName === "rebase" ||
        actionName === "rebase and push";
      await refreshAll({ fetchRemote: isRemoteAction }, actionLaneId);
      if (isRemoteAction && isViewingLane(actionLaneId)) {
        setForcePushSuggested(false);
      }
      if (isRemoteAction) {
        patchLaneGitActionsCachedState(projectRoot, actionLaneId, { forcePushSuggested: false });
      }
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: `${actionName} completed`,
        error: null,
      });
      scheduleLaneGitActionRuntimeClear(actionLaneId, actionVersion, 3_000, {
        notice: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "__ade_cancelled__") {
        patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
          busyAction: null,
          notice: null,
          error: null,
        });
        return;
      }
      if (actionName === "push" && isNonFastForwardError(message)) {
        patchLaneGitActionsCachedState(projectRoot, actionLaneId, { forcePushSuggested: true });
        if (isViewingLane(actionLaneId)) {
          setForcePushSuggested(true);
        }
      }
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: null,
        error: formatActionError(actionName, message),
      });
    }
  };

  const completeCommitRefresh = useCallback(async (targetLaneId: string) => {
    await refreshLaneGitState(targetLaneId);
    if (isViewingLane(targetLaneId)) {
      setCommitTimelineKey((prev) => prev + 1);
      setCommitMessage("");
      setAmendCommit(false);
    }
  }, [isViewingLane, refreshLaneGitState]);

  const submitCommit = useCallback(async () => {
    if (!laneId || (!hasStaged && !amendCommit) || busyAction != null) return;

    const message = commitMessage.trim();
    if (message.length > 0) {
      void runAction(amendCommit ? "amend commit" : "commit", async () => {
        await window.ade.git.commit({ laneId, message, amend: amendCommit });
        await completeCommitRefresh(laneId);
      });
      return;
    }

    const actionLaneId = laneId;
    const actionVersion = beginLaneGitActionRuntime(actionLaneId, {
      busyAction: AUTO_GENERATE_COMMIT_ACTION,
      notice: "Generating commit message...",
      error: null,
    });
    try {
      const generated = await window.ade.git.generateCommitMessage({ laneId: actionLaneId, amend: amendCommit });
      if (isViewingLane(actionLaneId)) {
        setCommitMessage(generated.message);
      }
      await window.ade.git.commit({ laneId: actionLaneId, message: generated.message, amend: amendCommit });
      await completeCommitRefresh(actionLaneId);
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: "commit completed",
        error: null,
      });
      scheduleLaneGitActionRuntimeClear(actionLaneId, actionVersion, 3_000, {
        notice: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: null,
        error: message,
      });
    }
  }, [
    amendCommit,
    busyAction,
    commitMessage,
    completeCommitRefresh,
    hasStaged,
    laneId,
  ]);

  useEffect(() => {
    const cached = readLaneGitActionsCachedState(projectRoot, laneId);
    setLoading(false);
    setChanges(cached?.changes ?? EMPTY_CHANGES);
    setStashes(cached?.stashes ?? []);
    setSyncStatus(cached?.syncStatus ?? null);
    setForcePushSuggested(cached?.forcePushSuggested ?? false);
    setCollapsedChangeFolders(new Set());
    setAmendCommit(false);
    setCommitMessageAi({ enabled: false, modelId: null });
    setAutoRebaseStatus(autoRebaseStatusSnapshotRef.current ?? cached?.autoRebaseStatus ?? null);
    setConflictState(cached?.conflictState ?? null);
    setStuckRebase(cached?.stuckRebase ?? null);
    if (!laneId) return;
    Promise.all([refreshChanges(laneId), refreshGitMeta(laneId)]).catch((err) => {
      patchLaneGitActionRuntimeState(laneId, {
        notice: null,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    void refreshCommitMessageAiState();
  }, [laneId, lane?.branchRef, projectRoot, refreshCommitMessageAiState]);

  useEffect(() => {
    if (!laneId) return;
    if (autoRebaseStatusSnapshotRef.current !== undefined) return;
    const targetLaneId = laneId;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      if (autoRebaseStatusSnapshotRef.current !== undefined) return;
      void refreshAutoRebaseStatus(targetLaneId);
    }, 3_500);
    return () => window.clearTimeout(timer);
  }, [laneId, lane?.branchRef, refreshAutoRebaseStatus]);

  useEffect(() => {
    if (!laneId) return;
    let refreshTimer: number | null = null;
    const effectLaneId = laneId;
    const refreshSyncStatus = () => {
      void window.ade.git
        .getSyncStatus({ laneId: effectLaneId })
        .then((nextStatus) => {
          patchLaneGitActionsCachedState(projectRoot, effectLaneId, { syncStatus: nextStatus });
          if (isViewingLane(effectLaneId)) {
            setSyncStatus(nextStatus);
          }
        })
        .catch(() => {
          if (isViewingLane(effectLaneId)) {
            setSyncStatus(null);
          }
        });
    };
    const scheduleRefreshSyncStatus = (delayMs = 0) => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (document.visibilityState !== "visible") return;
        refreshSyncStatus();
      }, delayMs);
    };
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      scheduleRefreshSyncStatus(250);
    }, 20_000);
    const onFocus = () => scheduleRefreshSyncStatus();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefreshSyncStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isViewingLane, laneId, projectRoot]);

  useEffect(() => {
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      if (!laneId) {
        setAutoRebaseStatus(null);
        return;
      }
      const nextStatus = event.statuses.find((entry) => entry.laneId === laneId) ?? null;
      patchLaneGitActionsCachedState(projectRoot, laneId, { autoRebaseStatus: nextStatus });
      setAutoRebaseStatus(nextStatus);
    });
    return unsubscribe;
  }, [laneId, projectRoot]);

  const changedFileCount = useMemo(() => {
    const paths = new Set<string>();
    for (const file of changes.staged) paths.add(file.path);
    for (const file of changes.unstaged) paths.add(file.path);
    return paths.size;
  }, [changes]);

  const rescueButtonTitle = useMemo(() => {
    if (!laneId) return "Select a lane first.";
    if (busyAction != null) return "Wait for the current git action to finish.";
    if (conflictState?.inProgress) {
      return conflictState.kind === "merge"
        ? "Finish the current merge before moving changes to a new lane."
        : "Finish the current rebase before moving changes to a new lane.";
    }
    if (hasStaged) return "Unstage all changes before moving unstaged work to a new lane.";
    if (!hasUnstaged) return "This lane has no unstaged changes to move.";
    return "Create a new child lane from this lane's current HEAD, then move unstaged and untracked changes into it while keeping them unstaged.";
  }, [busyAction, conflictState, hasStaged, hasUnstaged, laneId]);

  const showRescueButton = Boolean(laneId) && (hasUnstaged || hasStaged);
  const rescueButtonDisabled = !laneId || busyAction != null || hasStaged || !hasUnstaged || Boolean(conflictState?.inProgress);

  const stagedPathSet = useMemo(() => new Set(changes.staged.map((file) => file.path)), [changes.staged]);
  const unstagedPathSet = useMemo(() => new Set(changes.unstaged.map((file) => file.path)), [changes.unstaged]);

  const toggleStageFile = async (path: string, isStaged: boolean) => {
    if (!laneId) return;
    if (isStaged) {
      await window.ade.git.unstageFile({ laneId, path });
    } else {
      await window.ade.git.stageFile({ laneId, path });
    }
    await refreshChanges();
  };

  const discardFile = (path: string) => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = window.confirm(`Discard all changes to ${path}? This cannot be undone.`);
    if (!ok) return;
    void runAction("discard file", async () => {
      await window.ade.git.discardFile({ laneId, path });
    });
  };

  const discardStagedFile = (path: string) => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = window.confirm(`Discard staged and unstaged changes to ${path}? This cannot be undone.`);
    if (!ok) return;
    void runAction("discard staged file", async () => {
      await window.ade.git.restoreStagedFile({ laneId, path });
    });
  };

  const discardAll = () => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = window.confirm(`Discard ALL unstaged changes (${changes.unstaged.length} file${changes.unstaged.length === 1 ? "" : "s"})? This cannot be undone.`);
    if (!ok) return;
    void runAction("discard all", async () => {
      for (const file of changes.unstaged) {
        await window.ade.git.discardFile({ laneId, path: file.path });
      }
    });
  };

  const discardAllStaged = () => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = window.confirm(`Discard ALL staged changes (${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"})? This also discards any unstaged edits to the same files and cannot be undone.`);
    if (!ok) return;
    void runAction("discard staged files", async () => {
      for (const file of changes.staged) {
        await window.ade.git.restoreStagedFile({ laneId, path: file.path });
      }
    });
  };

  const stageAll = () => {
    if (!laneId) return;
    void runAction("stage all", async () => {
      await window.ade.git.stageAll({ laneId, paths: changes.unstaged.map((file) => file.path) });
    });
  };

  const moveUnstagedToNewLane = useCallback(async () => {
    if (!laneId || busyAction != null) return;
    if (hasStaged) {
      patchLaneGitActionRuntimeState(laneId, {
        notice: null,
        error: "This lane has staged changes. Unstage all changes before moving unstaged work to a new lane.",
      });
      return;
    }
    if (!hasUnstaged) {
      patchLaneGitActionRuntimeState(laneId, {
        notice: null,
        error: "This lane has no unstaged changes to move.",
      });
      return;
    }
    if (conflictState?.inProgress) {
      const kindLabel = conflictState.kind === "merge" ? "merge" : "rebase";
      patchLaneGitActionRuntimeState(laneId, {
        notice: null,
        error: `Finish the current ${kindLabel} before moving changes to a new lane.`,
      });
      return;
    }

    const name = await requestTextInput({
      title: "Move unstaged to new lane",
      message: "Create a child lane from this lane's current HEAD and move unstaged plus untracked changes into it.",
      placeholder: "e.g. feature/rescue-work",
      confirmLabel: "Create lane",
      validate: (value) => (value.trim().length ? null : "Lane name is required."),
    });
    if (name == null) return;

    const actionLaneId = laneId;
    const actionVersion = beginLaneGitActionRuntime(actionLaneId, {
      busyAction: "move unstaged",
      notice: null,
      error: null,
    });
    try {
      const created = await window.ade.lanes.createFromUnstaged({ sourceLaneId: actionLaneId, name });
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: null,
        error: null,
      });
      await refreshLanes();
      selectLane(created.id);
      navigate(`/lanes?laneId=${encodeURIComponent(created.id)}&focus=single`);
    } catch (err) {
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [busyAction, conflictState, hasStaged, hasUnstaged, laneId, navigate, refreshLanes, requestTextInput, selectLane]);

  const unstageAll = () => {
    if (!laneId) return;
    void runAction("unstage all", async () => {
      await window.ade.git.unstageAll({ laneId, paths: changes.staged.map((file) => file.path) });
    });
  };

  const runPush = (forceWithLease: boolean) => {
    if (!laneId) return;
    void runAction(forceWithLease ? "force push" : "push", async () => {
      await window.ade.git.push({ laneId, forceWithLease });
    });
  };

  const runPull = (mode: GitSyncMode) => {
    if (!laneId) return;
    void runAction("pull", async () => {
      const latestConflictState = await window.ade.git.getConflictState(laneId).catch(() => null);
      if (latestConflictState?.inProgress) {
        setConflictState(latestConflictState);
        setStuckRebase(latestConflictState.kind === "rebase" ? latestConflictState : null);
        const kindLabel = latestConflictState.kind === "merge" ? "merge" : "rebase";
        throw new Error(`Finish the current ${kindLabel} before pulling remote changes.`);
      }
      const latestSyncStatus = await window.ade.git.getSyncStatus({ laneId }).catch(() => null);
      if (latestSyncStatus) setSyncStatus(latestSyncStatus);
      const targetBaseRef = latestSyncStatus?.hasUpstream && latestSyncStatus.upstreamRef
        ? latestSyncStatus.upstreamRef
        : (lane?.baseRef ?? undefined);
      await window.ade.git.sync({ laneId, mode, baseRef: targetBaseRef });
    });
  };

  const runFetchOnly = () => {
    if (!laneId) return;
    void runAction("fetch", async () => {
      await window.ade.git.fetch({ laneId });
    });
  };

  const runRebaseAndPushFlow = (confirmPublish = true) => {
    if (!laneId) return;
    void runAction("rebase and push", async () => {
      if (onRebaseAndPush) {
        await onRebaseAndPush(laneId);
        return;
      }

      const start = await window.ade.lanes.rebaseStart({
        laneId,
        scope: "lane_only",
        pushMode: "none",
        actor: "user"
      });
      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
        throw new Error(start.run.error ?? "Rebase failed.");
      }

      await window.ade.git.fetch({ laneId }).catch(() => {});
      const latestSyncStatus = await window.ade.git.getSyncStatus({ laneId });
      setSyncStatus(latestSyncStatus);

      if (!latestSyncStatus.hasUpstream) {
        const missingRemote = latestSyncStatus.upstreamState === "missing";
        if (confirmPublish) {
          const ok = window.confirm(
            missingRemote
              ? `The remote branch for lane '${lane?.name ?? laneId}' is missing. Recreate origin/${lane?.branchRef ?? "current branch"}?`
              : `Publish lane '${lane?.name ?? laneId}' to origin/${lane?.branchRef ?? "current branch"}?`
          );
          if (!ok) throw new Error("__ade_cancelled__");
        }
        await window.ade.git.push({ laneId });
        return;
      }

      if (latestSyncStatus.diverged && latestSyncStatus.ahead > 0) {
        if (confirmPublish) {
          const ok = window.confirm(
            `Lane '${lane?.name ?? laneId}' diverged from remote (${latestSyncStatus.ahead} local ahead, ${latestSyncStatus.behind} remote ahead). Force push with lease now?`
          );
          if (!ok) throw new Error("__ade_cancelled__");
        }
        await window.ade.git.push({ laneId, forceWithLease: true });
        return;
      }

      if (latestSyncStatus.ahead > 0) {
        if (confirmPublish) {
          const ok = window.confirm(
            `Push ${latestSyncStatus.ahead} commit${latestSyncStatus.ahead === 1 ? "" : "s"} for lane '${lane?.name ?? laneId}' now?`
          );
          if (!ok) throw new Error("__ade_cancelled__");
        }
        await window.ade.git.push({ laneId });
      }
    });
  };

  const upstreamMissing = syncStatus?.upstreamState === "missing";

  const nextActionHint = useMemo<NextActionHint | null>(() => {
    if (!laneId) return null;
    if (conflictState?.inProgress) {
      const kindLabel = conflictState.kind === "merge" ? "merge" : "rebase";
      return {
        action: "resolve_conflicts",
        label: conflictState.canContinue ? `Continue ${kindLabel}` : `Resolve ${kindLabel}`,
        detail: conflictState.conflictedFiles.length > 0
          ? `${conflictState.conflictedFiles.length} conflicted file${conflictState.conflictedFiles.length === 1 ? "" : "s"} must be resolved before pull/push can continue.`
          : `Finish the current ${kindLabel} before doing any remote sync operations.`
      };
    }
    if (lane?.parentLaneId && lane.status.behind > 0) {
      return {
        action: "rebase_push",
        label: "Rebase and push",
        detail: `Behind parent by ${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"}. Rebase locally, then publish the rewritten branch.`
      };
    }
    if (forcePushSuggested) {
      return {
        action: "force_push_lease",
        label: "Force push (lease)",
        detail: "The last push was rejected because the remote branch history changed."
      };
    }
    if (!syncStatus) return null;
    if (syncStatus.upstreamState === "missing") {
      return {
        action: "push",
        label: "Remote branch missing",
        detail: "This lane used to track a remote branch, but that branch no longer exists. It may have been deleted after merge."
      };
    }
    if (!syncStatus.hasUpstream) {
      return {
        action: "push",
        label: "Publish lane",
        detail: "No remote branch exists yet. Publish once so collaborators and PRs can see this lane."
      };
    }
    if (syncStatus.recommendedAction === "push") {
      return {
        action: "push",
        label: "Push",
        detail: `${syncStatus.ahead} local commit${syncStatus.ahead === 1 ? "" : "s"} are ready to send to remote.`
      };
    }
    if (syncStatus.recommendedAction === "pull") {
      if (syncStatus.diverged) {
        return {
          action: "pull",
          label: "Resolve divergence",
          detail: "Remote and local both changed. Pull (rebase) keeps remote changes; force push publishes your rewritten local history."
        };
      }
      return {
        action: "pull",
        label: "Pull",
        detail: `${syncStatus.behind} upstream commit${syncStatus.behind === 1 ? "" : "s"} have not been brought into this lane yet.`
      };
    }
    return null;
  }, [conflictState, forcePushSuggested, lane, laneId, syncStatus]);

  const divergedSync = Boolean(syncStatus?.diverged);
  const behindCount = syncStatus?.behind ?? 0;
  const mergeConflictState = conflictState?.inProgress && conflictState.kind === "merge" ? conflictState : null;
  const pullBlockedByConflict = Boolean(conflictState?.inProgress);
  const headerDotColor = getLaneHeaderDotColor(lane);
  const rebaseConflictParentLaneId = autoRebaseStatus?.parentLaneId ?? lane?.parentLaneId ?? null;
  const commitButtonLabel = getCommitButtonLabel({ busyAction, amendCommit });
  const commitHelperText = getCommitHelperText({ commitMessage, commitMessageAi });
  const syncButtonDisabled = !laneId || busyAction != null || lane?.status.behind === 0 || lane?.status.dirty;
  const syncButtonTitle = useMemo(() => {
    if (!laneId) return "Sync is unavailable until you select a child lane.";
    if (busyAction) return `Sync is unavailable while '${busyAction}' is running.`;
    if (!lane?.parentLaneId) return "Sync is only available for child lanes that track a parent lane.";
    if (lane.status.dirty) {
      return "Sync is unavailable because this lane has uncommitted changes. Commit, stash, or discard them before rebasing and pushing.";
    }
    if (lane.status.behind === 0) {
      return `Sync is unavailable because ${lane.name} is already up to date with ${parentLane?.name ?? "its parent lane"}.`;
    }
    return `Rebase ${lane.name} onto ${parentLane?.name ?? "its parent lane"} and push the rewritten branch.`;
  }, [busyAction, lane, laneId, parentLane]);

  const renderFileRow = (file: FileChange, mode: "staged" | "unstaged") => {
    const rowSelected = selectedPath === file.path && selectedMode === mode;
    const alsoStaged = mode === "unstaged" && stagedPathSet.has(file.path);
    const alsoUnstaged = mode === "staged" && unstagedPathSet.has(file.path);
    const kindColor = getFileKindColor(file.kind);
    const stageToggleLabel = mode === "staged" ? `Unstage ${file.path}` : `Stage ${file.path}`;

    return (
      <div
        key={`${mode}:${file.path}`}
        className="group flex items-center gap-2 cursor-pointer transition-all duration-150"
        style={{
          padding: "7px 8px",
          fontSize: 12,
          fontFamily: MONO_FONT,
          borderLeft: rowSelected ? `3px solid ${COLORS.accent}` : "3px solid transparent",
          background: rowSelected ? COLORS.accentSubtle : "transparent",
          color: rowSelected ? COLORS.textPrimary : COLORS.textMuted,
        }}
        onClick={() => {
          onSelectCommit(null);
          onSelectFile(file.path, mode);
        }}
        onMouseEnter={(event) => {
          if (!rowSelected) event.currentTarget.style.background = COLORS.hoverBg;
        }}
        onMouseLeave={(event) => {
          if (!rowSelected) event.currentTarget.style.background = "transparent";
        }}
      >
        <SmartTooltip content={{
          label: mode === "staged" ? "Unstage File" : "Stage File",
          description: mode === "staged"
            ? "Remove this file from the staging area. Changes are kept but won't be in the next commit."
            : "Add this file to the staging area so it will be included in the next commit.",
          gitCommand: mode === "staged" ? `git reset HEAD "${file.path}"` : `git add "${file.path}"`,
          effect: mode === "staged" ? `Unstage ${file.path}` : `Stage ${file.path}`,
        }}>
          <button
            type="button"
            aria-label={stageToggleLabel}
            title={stageToggleLabel}
            className="shrink-0 flex items-center justify-center"
            style={{
              width: 16,
              height: 16,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              cursor: "pointer",
            }}
            onClick={(event) => {
              event.stopPropagation();
              void toggleStageFile(file.path, mode === "staged");
            }}
          >
            {mode === "staged" ? <Check size={9} style={{ color: COLORS.accent }} /> : null}
          </button>
        </SmartTooltip>
        <span
          className="shrink-0"
          title={`${file.kind} file`}
          style={{ width: 7, height: 7, borderRadius: "50%", background: kindColor }}
        />
        <span className="truncate flex-1" style={{ fontSize: 11 }} title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
        </span>
        {file.additions != null && file.additions > 0 ? (
          <span style={{ fontSize: 10, color: COLORS.success }}>+{file.additions}</span>
        ) : null}
        {file.deletions != null && file.deletions > 0 ? (
          <span style={{ fontSize: 10, color: COLORS.danger }}>-{file.deletions}</span>
        ) : null}
        {file.isBinary ? (
          <span style={inlineBadge(COLORS.textDim, { fontSize: 9 })}>binary</span>
        ) : null}
        {(alsoStaged || alsoUnstaged) ? (
          <span
            title="This file has both staged and unstaged changes."
            style={inlineBadge(COLORS.warning, { fontSize: 9 })}
          >
            PARTIAL
          </span>
        ) : null}
        {mode === "unstaged" ? (
          <SmartTooltip content={{
            label: "Discard Changes",
            description: `Revert ${file.path} to its last committed state.`,
            gitCommand: `git checkout -- "${file.path}"`,
            effect: `Discard all changes to ${file.path}`,
            warning: "This cannot be undone",
          }}>
            <button
              type="button"
              className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center"
              style={{
                width: 20,
                height: 20,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: COLORS.textDim,
              }}
              aria-label={`Discard changes to ${file.path}`}
              onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.danger; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
              onFocus={(e) => { e.currentTarget.style.color = COLORS.danger; }}
              onBlur={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
              disabled={!!busyAction}
              onClick={(event) => {
                event.stopPropagation();
                void discardFile(file.path);
              }}
            >
            <Trash size={12} />
          </button>
          </SmartTooltip>
        ) : (
          <SmartTooltip content={{
            label: "Discard Staged Changes",
            description: `Revert ${file.path} to its last committed state.`,
            gitCommand: `git restore --staged --worktree --source=HEAD -- "${file.path}"`,
            effect: `Discard staged and unstaged changes to ${file.path}`,
            warning: "This cannot be undone",
          }}>
            <button
              type="button"
              className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center"
              style={{
                width: 20,
                height: 20,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: COLORS.textDim,
              }}
              aria-label={`Discard staged changes to ${file.path}`}
              onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.danger; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
              onFocus={(e) => { e.currentTarget.style.color = COLORS.danger; }}
              onBlur={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
              disabled={!!busyAction}
              onClick={(event) => {
                event.stopPropagation();
                void discardStagedFile(file.path);
              }}
            >
              <Trash size={12} />
            </button>
          </SmartTooltip>
        )}
      </div>
    );
  };

  const renderChangeTreeNode = (
    node: ChangeTreeNode,
    mode: "staged" | "unstaged",
    depth: number,
    statsByPath: Map<string, ChangeTreeStats>,
  ): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

    for (const dir of dirs) {
      const key = `${mode}:${dir.path}`;
      const collapsed = collapsedChangeFolders.has(key);
      const stats = statsByPath.get(dir.path) ?? getChangeTreeStats(dir);
      rows.push(
        <button
          key={key}
          type="button"
          className="flex w-full items-center gap-2 text-left"
          style={{
            padding: "5px 8px",
            paddingLeft: 8 + depth * 14,
            color: COLORS.textMuted,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontFamily: MONO_FONT,
            fontSize: 11,
          }}
          onClick={() => {
            setCollapsedChangeFolders((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = COLORS.hoverBg; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          {collapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
          <Folder size={13} weight="duotone" />
          <span className="truncate" style={{ flex: 1 }}>{dir.name}</span>
          <span style={{ color: COLORS.textDim }}>{stats.files}</span>
          {stats.additions > 0 ? <span style={{ color: COLORS.success }}>+{stats.additions}</span> : null}
          {stats.deletions > 0 ? <span style={{ color: COLORS.danger }}>-{stats.deletions}</span> : null}
        </button>
      );
      if (!collapsed) rows.push(...renderChangeTreeNode(dir, mode, depth + 1, statsByPath));
    }

    for (const file of files) {
      rows.push(
        <div key={`${mode}:wrap:${file.path}`} style={{ paddingLeft: depth * 14 }}>
          {renderFileRow(file, mode)}
        </div>
      );
    }

    return rows;
  };

  const renderChangeTree = (files: FileChange[], mode: "staged" | "unstaged", statsByPath: Map<string, ChangeTreeStats>) => {
    const tree = buildChangeTree(files);
    return renderChangeTreeNode(tree, mode, 0, statsByPath);
  };

  const diffViewActive = Boolean(
    (selectedPath && selectedMode) || selectedCommit,
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
      <div
        className="shrink-0"
        style={{ padding: "12px 16px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}
      >
        <div className="flex flex-wrap items-center gap-2" style={{ rowGap: 8 }}>
          <span
            className="shrink-0"
            title={getLaneHeaderDotTitle(lane)}
            style={{ width: 10, height: 10, borderRadius: "50%", background: headerDotColor }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              letterSpacing: "1px",
              textTransform: "uppercase",
              color: COLORS.textPrimary,
            }}
            className="truncate"
            title={lane?.name}
          >
            {lane?.name ?? "NO LANE"}
          </span>
          {lane?.linearIssue ? (
            <LinearIssueBadge issue={lane.linearIssue} />
          ) : null}
          {lane ? (
            <>
              <span
                title={`Git branch: ${lane.branchRef}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                  color: COLORS.accent,
                  background: "color-mix(in srgb, var(--color-accent) 15%, transparent)",
                  letterSpacing: "0.5px",
                }}
              >
                <BranchIcon size={11} weight="bold" style={{ flexShrink: 0, color: COLORS.accent }} />
                {lane.branchRef}
              </span>
              <span
                title={lane.status.dirty ? "Worktree has uncommitted changes." : "Worktree is clean."}
                style={{
                  padding: "3px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                  color: lane.status.dirty ? COLORS.warning : "#10B981",
                  background: lane.status.dirty ? "color-mix(in srgb, var(--color-warning) 15%, transparent)" : "#10B98115",
                  letterSpacing: "0.5px",
                }}
              >
                {lane.status.dirty ? "DIRTY" : "CLEAN"}
              </span>
            </>
          ) : null}
          <div
            className="flex flex-wrap items-center gap-2"
            style={{ marginLeft: responsiveMode === "wide" ? "auto" : 0, color: COLORS.textDim }}
          >
            {lane ? (
              <span
                style={{ fontSize: 10, fontFamily: MONO_FONT, letterSpacing: "0.4px" }}
                title={`${lane.status.ahead} commit${lane.status.ahead === 1 ? "" : "s"} ahead of base, ${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"} behind base`}
              >
                base ↑{lane.status.ahead} ↓{lane.status.behind}
              </span>
            ) : null}
            {syncStatus ? (
              syncStatus.upstreamState === "missing" ? (
                <span
                  style={{ fontSize: 10, fontFamily: MONO_FONT, letterSpacing: "0.4px", color: COLORS.warning }}
                  title="The configured upstream branch no longer exists on remote. It may have been deleted after merge."
                >
                  remote missing
                </span>
              ) : syncStatus.hasUpstream ? (
                <span
                  style={{ fontSize: 10, fontFamily: MONO_FONT, letterSpacing: "0.4px" }}
                  title={`Compared to ${syncStatus.upstreamRef ?? "upstream"}`}
                >
                  remote ↑{syncStatus.ahead} ↓{syncStatus.behind}
                </span>
              ) : (
                <span
                  style={{ fontSize: 10, fontFamily: MONO_FONT, letterSpacing: "0.4px", color: COLORS.warning }}
                  title="This lane has not been published to remote yet."
                >
                  remote unpublished
                </span>
              )
            ) : null}
          </div>
        </div>
        {lane && originLabel ? (
          <div
            title="The parent lane this branch was created from."
            style={{ marginTop: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, letterSpacing: "0.5px" }}
          >
            {originLabel}
          </div>
        ) : null}
      </div>

      {stuckRebase ? (
        <div
          className="shrink-0"
          style={{
            padding: "10px 16px",
            background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
            borderBottom: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
          }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Warning size={16} weight="bold" color={COLORS.danger} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 11, fontWeight: 700, fontFamily: MONO_FONT, letterSpacing: "0.8px", textTransform: "uppercase", color: COLORS.danger }}>
                Rebase in progress
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 2, letterSpacing: "0.3px" }}>
                {stuckRebase.conflictedFiles.length > 0
                  ? `${stuckRebase.conflictedFiles.length} conflicted file${stuckRebase.conflictedFiles.length === 1 ? "" : "s"}. Commits and pushes are blocked until you resolve them.`
                  : "An interrupted rebase is blocking commits and pushes. Abort or continue to unlock the lane."}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {stuckRebase.canAbort ? (
                <SmartTooltip content={{
                  label: "Abort Rebase",
                  description: "Cancel the rebase and return to the state before it started. All rebase progress is discarded.",
                  gitCommand: "git rebase --abort",
                  effect: "Undo the rebase and restore the previous branch state",
                  warning: "Any resolved conflicts will be lost",
                }}>
                  <button
                    type="button"
                    style={dangerButton({ height: 28, padding: "0 12px", fontSize: 10 })}
                    disabled={busyAction != null}
                    onClick={() => {
                      if (!laneId) return;
                      void runAction("abort rebase", async () => {
                        await window.ade.git.rebaseAbort(laneId);
                      });
                    }}
                  >
                    ABORT REBASE
                  </button>
                </SmartTooltip>
              ) : null}
              {stuckRebase.canContinue ? (
                <SmartTooltip content={{
                  label: "Continue Rebase",
                  description: "Continue the rebase after resolving conflicts. The next commit in the rebase sequence will be applied.",
                  gitCommand: "git rebase --continue",
                  effect: "Apply resolved conflicts and continue rebasing",
                }}>
                  <button
                    type="button"
                    style={primaryButton({ height: 28, padding: "0 12px", fontSize: 10 })}
                    disabled={busyAction != null}
                    onClick={() => {
                      if (!laneId) return;
                      void runAction("continue rebase", async () => {
                        await window.ade.git.rebaseContinue(laneId);
                      });
                    }}
                  >
                    CONTINUE REBASE
                  </button>
                </SmartTooltip>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {mergeConflictState ? (
        <div
          className="shrink-0"
          style={{
            padding: "10px 16px",
            background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
            borderBottom: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
          }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Warning size={16} weight="bold" color={COLORS.danger} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 11, fontWeight: 700, fontFamily: MONO_FONT, letterSpacing: "0.8px", textTransform: "uppercase", color: COLORS.danger }}>
                Merge in progress
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 2, letterSpacing: "0.3px" }}>
                {mergeConflictState.conflictedFiles.length > 0
                  ? `${mergeConflictState.conflictedFiles.length} conflicted file${mergeConflictState.conflictedFiles.length === 1 ? "" : "s"}. Resolve them before continuing or aborting the merge.`
                  : "An interrupted merge is blocking pull and push actions. Continue or abort to unlock the lane."}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mergeConflictState.canAbort ? (
                <SmartTooltip content={{
                  label: "Abort Merge",
                  description: "Cancel the merge and return to the state before it started.",
                  gitCommand: "git merge --abort",
                  effect: "Undo the merge and restore the previous branch state",
                  warning: "Any resolved conflicts will be lost",
                }}>
                  <button
                    type="button"
                    style={dangerButton({ height: 28, padding: "0 12px", fontSize: 10 })}
                    disabled={busyAction != null}
                    onClick={() => {
                      if (!laneId) return;
                      void runAction("abort merge", async () => {
                        await window.ade.git.mergeAbort(laneId);
                      });
                    }}
                  >
                    ABORT MERGE
                  </button>
                </SmartTooltip>
              ) : null}
              {mergeConflictState.canContinue ? (
                <SmartTooltip content={{
                  label: "Continue Merge",
                  description: "Finish the merge after resolving all conflicts. A merge commit will be created.",
                  gitCommand: "git merge --continue",
                  effect: "Create the merge commit with resolved conflicts",
                }}>
                  <button
                    type="button"
                    style={primaryButton({ height: 28, padding: "0 12px", fontSize: 10 })}
                    disabled={busyAction != null}
                    onClick={() => {
                      if (!laneId) return;
                      void runAction("continue merge", async () => {
                        await window.ade.git.mergeContinue(laneId);
                      });
                    }}
                  >
                    CONTINUE MERGE
                  </button>
                </SmartTooltip>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {autoRebaseStatus ? (() => {
        const bannerConfig = getAutoRebaseBannerConfig(autoRebaseStatus.state);
        const isAutoRebaseFailure = autoRebaseStatus.state === "rebaseConflict" || autoRebaseStatus.state === "rebaseFailed";
        const bannerMessage = isAutoRebaseFailure
          ? autoRebaseStatus.message
            ? `Auto-rebase failed. ${autoRebaseStatus.message}`
            : bannerConfig.fallbackMessage
          : autoRebaseStatus.message ?? bannerConfig.fallbackMessage;
        const openRebaseTab = () => {
          if (!laneId) return;
          if (autoRebaseStatus.state === "rebaseConflict" && onResolveRebaseConflict) {
            onResolveRebaseConflict(laneId, rebaseConflictParentLaneId);
            return;
          }
          const search = new URLSearchParams({ tab: "workflows", workflow: "rebase", laneId });
          if (rebaseConflictParentLaneId) search.set("parentLaneId", rebaseConflictParentLaneId);
          navigate(`/prs?${search.toString()}`);
        };
        return (
          <div
            className="shrink-0 flex flex-wrap items-center gap-3"
            style={{
              padding: "8px 16px",
              fontSize: 10,
              fontFamily: MONO_FONT,
              borderBottom: `1px solid ${COLORS.border}`,
              background: `${bannerConfig.color}08`,
              color: bannerConfig.color
            }}
          >
            <span style={{ ...LABEL_STYLE, color: "inherit" }}>
              {bannerConfig.label}
            </span>
            <span className="truncate" style={{ color: COLORS.textMuted, letterSpacing: "0.5px", flex: 1, minWidth: 220 }}>
              {bannerMessage}
            </span>
            {autoRebaseStatus.state !== "autoRebased" ? (
              isAutoRebaseFailure ? (
                <SmartTooltip content={{
                  label: "Open Rebase/Merge Tab",
                  description: "View detailed rebase information and resolve issues.",
                  effect: "Navigate to the rebase details view",
                }}>
                  <button
                    type="button"
                    style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), border: "1px solid color-mix(in srgb, var(--color-accent) 50%, transparent)" }}
                    disabled={!laneId || busyAction != null}
                    onClick={openRebaseTab}
                  >
                    OPEN REBASE/MERGE TAB
                  </button>
                </SmartTooltip>
              ) : (
                <SmartTooltip content={{
                  label: "Rebase and Push",
                  description: "Rebase this lane onto its parent, then push the rewritten branch to remote.",
                  gitCommand: "git rebase <parent> && git push",
                  effect: "Rebase from parent and push to remote",
                }}>
                  <button
                    type="button"
                    style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), border: "1px solid color-mix(in srgb, var(--color-accent) 50%, transparent)" }}
                    disabled={!laneId || busyAction != null}
                    onClick={() => runRebaseAndPushFlow(true)}
                  >
                    REBASE AND PUSH
                  </button>
                </SmartTooltip>
              )
            ) : null}
          </div>
        );
      })() : null}

      <div className="flex-1 min-h-0 overflow-hidden" style={{ display: "flex", flexDirection: "column" }}>
        {/* ─── Compact Action Toolbar ─── */}
        <div
          className="shrink-0"
          data-testid="action-toolbar"
          style={{
            padding: "6px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            background: COLORS.cardBg,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            {/* Commit controls */}
            <input
              disabled={busyAction != null}
              style={{
                height: 30,
                flex: "1 1 180px",
                minWidth: 0,
                padding: "0 8px",
                fontSize: 11,
                fontFamily: MONO_FONT,
                letterSpacing: "0.4px",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textSecondary,
                outline: "none",
                borderRadius: 6,
                opacity: busyAction != null ? 0.7 : 1,
              }}
              placeholder="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitCommit();
                }
              }}
            />
            <SmartTooltip content={{
              label: amendCommit ? "Amend ON" : "Amend",
              description: getAmendSummary(amendCommit),
              gitCommand: amendCommit ? "git commit --amend" : undefined,
              effect: amendCommit ? "Your next commit will rewrite the latest commit" : "Click to enable amend mode",
            }}>
              <button
                type="button"
                style={{
                  ...outlineButton({ height: 30, padding: "0 8px", fontSize: 10, borderRadius: 6 }),
                  color: amendCommit ? COLORS.warning : COLORS.textDim,
                  border: `1px solid ${amendCommit ? "color-mix(in srgb, var(--color-warning) 40%, transparent)" : COLORS.outlineBorder}`,
                  background: amendCommit ? "color-mix(in srgb, var(--color-warning) 10%, transparent)" : "transparent",
                }}
                disabled={busyAction != null}
                onClick={() => setAmendCommit((prev) => !prev)}
              >
                {amendCommit ? "AMEND ON" : "AMEND"}
              </button>
            </SmartTooltip>
            <SmartTooltip content={{
              label: amendCommit ? "Amend Commit" : "Commit",
              description: amendCommit ? "Rewrite the latest commit with current staged changes and message." : "Create a new commit from staged changes.",
              gitCommand: amendCommit ? "git commit --amend" : "git commit",
              effect: hasStaged
                ? `${amendCommit ? "Amend" : "Commit"} ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`
                : "No staged files to commit",
              shortcut: `${modifierKeyLabel}+Enter`,
            }}>
              <button
                type="button"
                style={{
                  ...primaryButton({ height: 30, padding: "0 12px", fontSize: 10, borderRadius: 6 }),
                  opacity: ((!hasStaged && !amendCommit) || busyAction != null) ? 0.45 : 1,
                  pointerEvents: ((!hasStaged && !amendCommit) || busyAction != null) ? "none" : "auto",
                }}
                disabled={(!hasStaged && !amendCommit) || busyAction != null}
                onClick={() => void submitCommit()}
              >
                {commitButtonLabel}
              </button>
            </SmartTooltip>

            {/* Separator */}
            <div style={{ width: 1, height: 20, background: COLORS.border, margin: "0 2px", flexShrink: 0 }} />

            {/* Sync controls */}
            <div className="flex items-center" style={{ gap: 2 }}>
              {(["merge", "rebase"] as const).map((mode) => (
                <SmartTooltip key={mode} content={{
                  label: mode === "merge" ? "Merge Mode" : "Rebase Mode",
                  description: getPullModeSummary(mode),
                  effect: syncMode === mode ? "Currently active" : `Switch pull strategy to ${mode}`,
                }}>
                  <button
                    type="button"
                    disabled={!laneId || busyAction != null}
                    onClick={() => setSyncMode(mode)}
                    style={{
                      ...outlineButton({ height: 26, padding: "0 6px", fontSize: 9, borderRadius: 4 }),
                      color: syncMode === mode ? COLORS.accent : COLORS.textDim,
                      border: `1px solid ${syncMode === mode ? "color-mix(in srgb, var(--color-accent) 40%, transparent)" : "transparent"}`,
                      background: syncMode === mode ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "transparent",
                      opacity: !laneId || busyAction != null ? 0.5 : 1,
                    }}
                  >
                    {mode === "merge" ? "MERGE" : "REBASE"}
                  </button>
                </SmartTooltip>
              ))}
            </div>
            <SmartTooltip content={{
              label: `Pull (${syncMode})`,
              description: getPullModeSummary(syncMode),
              gitCommand: syncMode === "merge" ? "git pull --no-rebase" : "git pull --rebase",
              effect: pullBlockedByConflict
                ? `Blocked: ${conflictState?.kind ?? "conflict"} in progress`
                : behindCount > 0
                  ? `Pull ${behindCount} commit${behindCount === 1 ? "" : "s"} from remote`
                  : "Already up to date with remote",
              warning: pullBlockedByConflict ? `Resolve the current ${conflictState?.kind ?? "conflict"} first` : undefined,
            }}>
              <button
                type="button"
                className={behindCount > 0 ? "pull-btn-flash" : undefined}
                style={{
                  ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                  ...((nextActionHint?.action === "pull" || nextActionHint?.action === "resolve_conflicts")
                    ? { color: COLORS.accent, border: "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }
                    : {}),
                }}
                disabled={!laneId || busyAction != null || pullBlockedByConflict}
                onClick={() => runPull(syncMode)}
              >
                <ArrowDown size={12} weight="bold" style={{ marginRight: 4 }} />
                PULL
                {behindCount > 0 && (
                  <span
                    style={{
                      marginLeft: 5,
                      background: COLORS.accent,
                      color: "#fff",
                      borderRadius: 8,
                      padding: "1px 5px",
                      fontSize: 9,
                      fontWeight: 700,
                      lineHeight: "14px",
                      minWidth: 16,
                      textAlign: "center" as const,
                      display: "inline-block",
                    }}
                  >
                    {behindCount}
                  </span>
                )}
              </button>
            </SmartTooltip>
            <SmartTooltip content={{
              label: upstreamMissing ? "Recreate" : syncStatus?.hasUpstream === false ? "Publish" : nextActionHint?.action === "force_push_lease" ? "Force Push" : "Push",
              description: upstreamMissing
                ? "Recreate the missing remote branch for this lane."
                : syncStatus?.hasUpstream === false
                  ? "Create the remote branch and connect this lane to it."
                  : nextActionHint?.action === "force_push_lease"
                    ? "Overwrite the remote branch with your local history after a rebase or amend."
                    : "Send your local commits to the tracked remote branch.",
              gitCommand: upstreamMissing || syncStatus?.hasUpstream === false
                ? `git push -u origin ${lane?.branchRef ?? "HEAD"}`
                : nextActionHint?.action === "force_push_lease"
                  ? "git push --force-with-lease"
                  : "git push",
              effect: upstreamMissing
                ? `Recreate the remote branch for "${lane?.name ?? ""}"`
                : syncStatus?.hasUpstream === false
                  ? `Publish lane "${lane?.name ?? ""}" to remote`
                  : (syncStatus?.ahead ?? 0) > 0
                    ? `Push ${syncStatus!.ahead} commit${syncStatus!.ahead === 1 ? "" : "s"} to remote`
                    : "No local commits to push",
              warning: nextActionHint?.action === "force_push_lease" ? "This overwrites remote history" : undefined,
            }}>
              <button
                type="button"
                style={{
                  ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                  ...(nextActionHint?.action === "push" || nextActionHint?.action === "force_push_lease" ? { color: COLORS.accent, border: "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" } : {}),
                }}
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (nextActionHint?.action === "force_push_lease") {
                    const ok = window.confirm(
                      "Force push with lease? This overwrites the remote branch with your local history. Only use this if you intend to publish rewritten commits.",
                    );
                    if (!ok) return;
                    runPush(true);
                  } else {
                    runPush(false);
                  }
                }}
              >
                <Upload size={12} weight="bold" style={{ marginRight: 4 }} />
                {upstreamMissing ? "RECREATE" : syncStatus?.hasUpstream === false ? "PUBLISH" : nextActionHint?.action === "force_push_lease" ? "FORCE PUSH" : "PUSH"}
              </button>
            </SmartTooltip>
            {lane?.parentLaneId ? (
              <HoverTitleButton
                type="button"
                style={{
                  ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                  ...(nextActionHint?.action === "rebase_push" ? { color: COLORS.accent, border: "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" } : {}),
                  opacity: syncButtonDisabled ? 0.45 : 1,
                }}
                disabled={syncButtonDisabled}
                onClick={() => runRebaseAndPushFlow(true)}
                tooltip={syncButtonTitle}
                smartTooltip={{
                  label: "Sync",
                  description: syncButtonTitle,
                  gitCommand: "git rebase <parent> && git push",
                  effect: lane?.status.behind > 0
                    ? `Rebase ${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"} from parent and push`
                    : "Already in sync with parent",
                }}
              >
                <Stack size={12} weight="bold" style={{ marginRight: 4 }} />
                SYNC
              </HoverTitleButton>
            ) : null}

            {/* Separator */}
            <div style={{ width: 1, height: 20, background: COLORS.border, margin: "0 2px", flexShrink: 0 }} />

            {/* Advanced toggle */}
            <SmartTooltip content={{
              label: "More",
              description: "Show advanced git operations like fetch, force push, rebase, revert, and cherry-pick.",
              effect: showAdvanced ? "Click to collapse" : "Click to expand",
            }}>
              <button
                type="button"
                style={{
                  ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                  color: showAdvanced ? COLORS.accent : COLORS.textMuted,
                  border: `1px solid ${showAdvanced ? "color-mix(in srgb, var(--color-accent) 30%, transparent)" : COLORS.outlineBorder}`,
                }}
                onClick={() => setShowAdvanced((prev) => !prev)}
              >
                MORE {showAdvanced ? "\u25B4" : "\u25BE"}
              </button>
            </SmartTooltip>

            {/* Refresh */}
            <SmartTooltip content={{
              label: "Refresh",
              description: "Fetch from remote and refresh all git state including file changes, sync status, and stashes.",
              gitCommand: "git fetch",
              effect: "Fetch latest remote state",
            }}>
              <button
                type="button"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 30,
                  height: 30,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  background: "transparent",
                  color: COLORS.textMuted,
                  cursor: "pointer",
                  borderRadius: 6,
                  flexShrink: 0,
                }}
                onClick={() => refreshAll({ fetchRemote: true }).catch(() => {})}
              >
                <ArrowsClockwise size={13} className={cn(loading && "animate-spin")} />
              </button>
            </SmartTooltip>
          </div>

          {/* Helper / status row */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.4 }}>
            <span style={{ minWidth: 0, flex: "1 1 auto" }}>{commitHelperText}</span>
            <div className="flex items-center gap-2" style={{ flexShrink: 0, fontSize: 10 }}>
              {nextActionHint ? (
                <span style={{ color: COLORS.accent, fontWeight: 500 }} title={nextActionHint.detail}>
                  NEXT: {nextActionHint.label}
                </span>
              ) : (
                <span style={{ color: COLORS.textDim }}>UP TO DATE</span>
              )}
              {divergedSync ? <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>DIVERGED</span> : null}
            </div>
          </div>
        </div>

        {/* ─── Advanced Git (collapsible) ─── */}
        {showAdvanced ? (
          <div
            className="shrink-0"
            data-testid="advanced-section"
            style={{
              padding: "8px 10px",
              background: COLORS.recessedBg,
              borderBottom: `1px solid ${COLORS.border}`,
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <ActionButton
                title="Fetch only"
                detail="Download remote updates without changing your local branch."
                disabled={!laneId || busyAction != null}
                onClick={runFetchOnly}
                smartTooltip={{
                  label: "Fetch Only",
                  description: "Download remote updates without merging or rebasing. Your local branch stays unchanged.",
                  gitCommand: "git fetch",
                  effect: "Check for new remote commits without modifying local files",
                }}
              />
              <ActionButton
                title="Force push (lease)"
                detail="Overwrite the remote branch only if nobody else pushed in the meantime."
                badge={nextActionHint?.action === "force_push_lease" || divergedSync ? "CHECK FIRST" : null}
                disabled={!laneId || busyAction != null}
                onClick={() => runPush(true)}
                smartTooltip={{
                  label: "Force Push (Lease)",
                  description: "Overwrite the remote branch only if nobody else pushed in the meantime. Safe for rebased or amended commits.",
                  gitCommand: "git push --force-with-lease",
                  effect: (syncStatus?.ahead ?? 0) > 0
                    ? `Force push ${syncStatus!.ahead} commit${syncStatus!.ahead === 1 ? "" : "s"}`
                    : "Force push current branch",
                  warning: "This will overwrite remote history",
                }}
              />
              {lane?.parentLaneId ? (
                <ActionButton
                  title="Rebase local only"
                  detail={lane?.status.behind === 0
                    ? "Already up to date with parent."
                    : lane?.status.dirty
                      ? "Commit or stash uncommitted changes before rebasing."
                      : "Update this lane from its parent without pushing anything yet."}
                  disabled={!laneId || busyAction != null || lane?.status.behind === 0 || lane?.status.dirty}
                  onClick={() => {
                    if (!laneId) return;
                    if (onRebaseNowLocal) {
                      void runAction("rebase", async () => {
                        await onRebaseNowLocal(laneId);
                      });
                      return;
                    }
                    void runAction("rebase", async () => {
                      const start = await window.ade.lanes.rebaseStart({
                        laneId,
                        scope: "lane_only",
                        pushMode: "none",
                        actor: "user"
                      });
                      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
                        throw new Error(start.run.error ?? "Rebase failed.");
                      }
                    });
                  }}
                  smartTooltip={{
                    label: "Rebase Local Only",
                    description: "Replay your commits on top of the parent branch without pushing. Use this to stay current before pushing.",
                    gitCommand: `git rebase ${parentLane?.branchRef ?? "<parent>"}`,
                    effect: lane?.status.behind === 0
                      ? "Already up to date with parent"
                      : lane?.status.dirty
                        ? "Cannot rebase: uncommitted changes present"
                        : `Rebase onto parent (${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"} behind)`,
                    warning: lane?.status.dirty ? "Commit or stash changes first" : undefined,
                  }}
                />
              ) : null}
              {lane?.parentLaneId ? (
                <ActionButton
                  title="View rebase details"
                  detail="See detailed rebase history, including conflicts and timing."
                  disabled={!laneId || busyAction != null}
                  onClick={() => onViewRebaseDetails?.(laneId)}
                  smartTooltip={{
                    label: "View Rebase Details",
                    description: "See detailed rebase history, including conflicts and timing.",
                    effect: "Open the rebase details panel",
                  }}
                />
              ) : null}
              <ActionButton
                title="Revert commit"
                detail="Create a new commit that undoes an earlier commit."
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (!laneId) return;
                  void runAction("revert commit", async () => {
                    const commits = await window.ade.git.listRecentCommits({ laneId, limit: 20 });
                    const sha = await requestTextInput({
                      title: "Commit SHA to revert",
                      defaultValue: commits[0]?.sha ?? "",
                      validate: (value) => (value ? null : "Commit SHA is required")
                    });
                    if (!sha) throw new Error("__ade_cancelled__");
                    await window.ade.git.revertCommit({ laneId, commitSha: sha });
                  });
                }}
                smartTooltip={{
                  label: "Revert Commit",
                  description: "Create a new commit that undoes the changes introduced by a previous commit. The original commit stays in history.",
                  gitCommand: "git revert <sha>",
                  effect: "You'll be prompted for a commit SHA to revert",
                }}
              />
              <ActionButton
                title="Cherry-pick"
                detail="Apply a commit from another branch onto this lane."
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (!laneId) return;
                  void runAction("cherry-pick", async () => {
                    const sha = await requestTextInput({
                      title: "Commit SHA to cherry-pick",
                      validate: (value) => (value ? null : "Commit SHA is required")
                    });
                    if (!sha) throw new Error("__ade_cancelled__");
                    await window.ade.git.cherryPickCommit({ laneId, commitSha: sha });
                  });
                }}
                smartTooltip={{
                  label: "Cherry-pick",
                  description: "Copy a commit from another branch and apply it on top of this lane. Creates a new commit with the same changes.",
                  gitCommand: "git cherry-pick <sha>",
                  effect: "You'll be prompted for a commit SHA to cherry-pick",
                }}
              />
            </div>
            {!autoRebaseEnabled && nextActionHint?.action === "rebase_push" ? (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  fontSize: 10,
                  fontFamily: MONO_FONT,
                  letterSpacing: "0.5px",
                  border: `1px solid ${COLORS.border}`,
                  background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
                  color: COLORS.info,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                  borderRadius: 6,
                }}
              >
                <span style={{ flex: 1, minWidth: 220 }}>
                  Auto-rebase is off. Enable it in Settings {" > "} Lane Templates if you want child lanes to auto-rebase and auto-push when their parent advances.
                </span>
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), marginLeft: "auto" }}
                  onClick={onOpenSettings}
                >
                  SETTINGS
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ─── Files + History (maximized) ─── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: responsiveMode === "narrow" ? "1fr" : "minmax(0, 1.15fr) minmax(320px, 0.85fr)",
            gridTemplateRows: responsiveMode === "narrow" ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
            padding: 10,
            gap: 10,
            flex: "1 1 0",
            minWidth: 0,
            minHeight: 0,
            alignItems: "stretch",
          }}
        >
          <SectionCard
            title={diffViewActive ? "Diff" : "Files"}
            description={
              diffViewActive
                ? (selectedCommit
                    ? `${selectedCommit.shortSha ?? (selectedCommit.sha ?? "").slice(0, 7)} · ${selectedCommit.subject.trim().slice(0, 120)}`
                    : `${selectedMode === "staged" ? "Staged" : "Unstaged"} · ${selectedPath ?? ""}`)
                : "Changed files. Stashes are saved snapshots below."
            }
            dataTestId="files-section"
            sectionStyle={{ minHeight: 0, height: "100%", background: "rgba(255,255,255,0.03)" }}
            headerStyle={{ background: "rgba(255,255,255,0.03)" }}
            bodyStyle={
              diffViewActive
                ? { flex: 1, minHeight: 0, padding: 0, gap: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "rgba(255,255,255,0.03)" }
                : { flex: 1, minHeight: 0, background: "rgba(255,255,255,0.03)" }
            }
            aside={
              diffViewActive ? (
                <SmartTooltip content={{ label: "Back to files", description: "Leave the diff viewer and return to the file list and stashes." }}>
                  <button
                    type="button"
                    style={outlineButton({ height: 24, padding: "0 10px", fontSize: 10, gap: 6 })}
                    disabled={!onClearDiffSelection}
                    onClick={() => onClearDiffSelection?.()}
                  >
                    <ArrowLeft size={12} weight="bold" />
                    Files
                  </button>
                </SmartTooltip>
              ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span title={`${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}`} style={inlineBadge(COLORS.accent, { fontSize: 9 })}>
                  {changedFileCount}
                </span>
                {changes.unstaged.length > 0 ? (
                  <>
                    <SmartTooltip content={{
                      label: "Stage All",
                      description: "Move all unstaged changes to the staging area so they will be included in the next commit.",
                      gitCommand: "git add .",
                      effect: `Stage ${changes.unstaged.length} file${changes.unstaged.length === 1 ? "" : "s"}`,
                    }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={stageAll}
                        disabled={busyAction != null}
                      >
                        STAGE ALL
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{
                      label: "Discard All Unstaged",
                      description: "Permanently discard all unstaged changes. Files revert to their last committed state.",
                      gitCommand: "git checkout -- .",
                      effect: `Discard changes in ${changes.unstaged.length} file${changes.unstaged.length === 1 ? "" : "s"}`,
                      warning: "This cannot be undone",
                    }}>
                      <button
                        type="button"
                        style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={discardAll}
                        disabled={busyAction != null}
                      >
                        DISCARD UNSTAGED
                      </button>
                    </SmartTooltip>
                  </>
                ) : null}
                {changes.staged.length > 0 ? (
                  <>
                    <SmartTooltip content={{
                      label: "Unstage All",
                      description: "Remove all files from the staging area. Changes are kept but won't be included in the next commit.",
                      gitCommand: "git reset HEAD",
                      effect: `Unstage ${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"}`,
                    }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={unstageAll}
                      >
                        UNSTAGE STAGED
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{
                      label: "Discard All Staged",
                      description: "Permanently discard all staged changes. If any staged file also has unstaged edits, those edits are discarded too.",
                      gitCommand: "git restore --staged --worktree --source=HEAD -- <paths>",
                      effect: `Discard staged changes in ${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"}`,
                      warning: "This cannot be undone",
                    }}>
                      <button
                        type="button"
                        style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={discardAllStaged}
                        disabled={busyAction != null}
                      >
                        DISCARD STAGED
                      </button>
                    </SmartTooltip>
                  </>
                ) : null}
                {showRescueButton ? (
                  <SmartTooltip content={{
                    label: "Create New Lane",
                    description: rescueButtonTitle,
                    effect: hasUnstaged && !hasStaged
                      ? `Move ${changes.unstaged.length} unstaged file${changes.unstaged.length === 1 ? "" : "s"} to a new child lane`
                      : "Unavailable",
                  }}>
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={rescueButtonDisabled}
                      title={rescueButtonTitle}
                      onClick={() => {
                        void moveUnstagedToNewLane();
                      }}
                    >
                      CREATE NEW LANE WITH CURRENT CHANGES
                    </button>
                  </SmartTooltip>
                ) : null}
              </div>
              )
            }
          >
            {diffViewActive ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <LaneDiffPane
                  laneId={laneId}
                  selectedPath={selectedPath}
                  selectedFileMode={selectedMode}
                  selectedCommit={selectedCommit}
                  liveSync
                />
              </div>
            ) : (
            <>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                paddingBottom: 8,
                borderBottom: `1px solid ${COLORS.border}`,
              }}
            >
              <div className="flex flex-wrap items-center gap-2" style={{ justifyContent: "space-between", rowGap: 6 }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span style={LABEL_STYLE}>BRANCH STASHES</span>
                  <span style={{ fontSize: 10, color: COLORS.textDim }}>
                    {stashes.length === 0 ? "None saved" : `${stashes.length} saved`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {stashes.length > 0 && (
                    <SmartTooltip content={{
                      label: "Clear Branch Stashes",
                      description: "Permanently delete this branch's visible stash entries. You'll be asked to confirm by typing the count.",
                      gitCommand: "git stash drop <branch stash refs>",
                      effect: `Delete ${stashes.length} branch stash${stashes.length === 1 ? "" : "es"}`,
                      warning: "This cannot be undone",
                    }}>
                      <button
                        type="button"
                        style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        disabled={!laneId || busyAction != null}
                        onClick={() => {
                          if (!laneId) return;
                          void runAction("stash clear", async () => {
                            const confirmation = await requestTextInput({
                              title: "Clear branch stashes?",
                              message: `This will permanently delete ${stashes.length} stash${stashes.length === 1 ? "" : "es"} saved for this branch. Type "${stashes.length}" to confirm.`,
                              placeholder: `Type ${stashes.length} to confirm`,
                              confirmLabel: "Delete all",
                              validate: (v) => v.trim() === String(stashes.length) ? null : "Type the number to confirm",
                            });
                            if (confirmation == null) throw new Error("__ade_cancelled__");
                            await window.ade.git.stashClear({ laneId });
                            await refreshGitMeta(laneId);
                          });
                        }}
                      >
                        CLEAR STASHES
                      </button>
                    </SmartTooltip>
                  )}
                  <SmartTooltip content={{
                    label: "Save Changes",
                    description: "Save this branch's current staged and unstaged changes to a stash without committing. You can restore them later.",
                    gitCommand: hasUntrackedChanges ? "git stash push -u" : "git stash push",
                    effect: hasStaged || hasUnstaged
                      ? `Stash ${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}${hasUntrackedChanges ? ", including untracked files" : ""}`
                      : "No changes to save",
                  }}>
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={!laneId || busyAction != null || (!hasStaged && !hasUnstaged)}
                      onClick={() => {
                        if (!laneId) return;
                        void runAction("stash push", async () => {
                          const msg = await requestTextInput({
                            title: "Stash message",
                            placeholder: "Optional note",
                            confirmLabel: "Save stash",
                          });
                          if (msg == null) throw new Error("__ade_cancelled__");
                          await window.ade.git.stashPush({ laneId, message: msg || undefined, includeUntracked: hasUntrackedChanges });
                        });
                      }}
                    >
                      SAVE CHANGES
                    </button>
                  </SmartTooltip>
                </div>
              </div>
              {stashes.length === 0 ? (
                <div style={{ fontSize: 10, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  Save this branch's in-progress changes without committing. You can restore them later.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {stashes.slice(0, maxVisibleStashes).map((stash) => (
                    <div
                      key={stash.ref}
                      style={{
                        padding: "6px 8px",
                        border: `1px solid ${COLORS.border}`,
                        background: COLORS.pageBg,
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <div className="flex flex-wrap items-center gap-2" style={{ minWidth: 0 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="truncate" style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                            {stash.subject || stash.ref}
                          </div>
                          <div className="truncate" style={{ fontSize: 9, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                            {stash.ref} · {formatRelativeTime(stash.createdAt)}
                          </div>
                        </div>
                        <SmartTooltip content={{
                          label: "Restore",
                          description: "Apply this stash's changes to your working directory and remove the stash entry. One-time use.",
                          gitCommand: `git stash pop ${stash.ref}`,
                          effect: `Restore "${stash.subject || stash.ref}" and remove it from stashes`,
                        }}>
                          <button
                            type="button"
                            style={{ ...outlineButton({ height: 24, padding: "0 8px", fontSize: 10 }), border: "1px solid color-mix(in srgb, var(--color-accent) 50%, transparent)" }}
                            disabled={!laneId || busyAction != null}
                            onClick={() => {
                              if (!laneId) return;
                              void runAction("stash pop", async () => {
                                await window.ade.git.stashPop({ laneId, stashRef: stash.ref, stashOid: stash.oid });
                                await refreshGitMeta(laneId);
                              });
                            }}
                          >
                            RESTORE
                          </button>
                        </SmartTooltip>
                        <SmartTooltip content={{
                          label: "Copy to Worktree",
                          description: "Apply this stash's changes to your working directory but keep the stash entry. Can be reused multiple times.",
                          gitCommand: `git stash apply ${stash.ref}`,
                          effect: `Apply "${stash.subject || stash.ref}" (stash stays saved)`,
                        }}>
                          <button
                            type="button"
                            style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                            disabled={!laneId || busyAction != null}
                            onClick={() => {
                              if (!laneId) return;
                              void runAction("stash apply", async () => {
                                await window.ade.git.stashApply({ laneId, stashRef: stash.ref, stashOid: stash.oid });
                              });
                            }}
                          >
                            COPY TO WORKTREE
                          </button>
                        </SmartTooltip>
                        <SmartTooltip content={{
                          label: "Delete Stash",
                          description: "Permanently delete this stash entry without restoring any changes.",
                          gitCommand: `git stash drop ${stash.ref}`,
                          effect: `Delete "${stash.subject || stash.ref}"`,
                          warning: "Changes in this stash will be lost permanently",
                        }}>
                          <button
                            type="button"
                            style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                            disabled={!laneId || busyAction != null}
                            onClick={() => {
                              if (!laneId) return;
                              void runAction("stash drop", async () => {
                                const confirmation = await requestTextInput({
                                  title: "Delete stash?",
                                  message: `This will permanently delete "${stash.subject || stash.ref}". Type "delete" to confirm.`,
                                  placeholder: "Type delete to confirm",
                                  confirmLabel: "Delete stash",
                                  validate: (v) => v.trim().toLowerCase() === "delete" ? null : "Type delete to confirm",
                                });
                                if (confirmation == null) throw new Error("__ade_cancelled__");
                                await window.ade.git.stashDrop({ laneId, stashRef: stash.ref, stashOid: stash.oid });
                                await refreshGitMeta(laneId);
                              });
                            }}
                          >
                            DELETE
                          </button>
                        </SmartTooltip>
                      </div>
                      <div style={{ fontSize: 9, color: COLORS.textDim, lineHeight: 1.4 }}>
                        Restore removes entry. Copy to Worktree keeps it. Delete discards permanently.
                      </div>
                    </div>
                  ))}
                  {stashes.length > maxVisibleStashes ? (
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                      +{stashes.length - maxVisibleStashes} more stash entr{stashes.length - maxVisibleStashes === 1 ? "y" : "ies"}.
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0, overflow: "auto" }}>
              {changes.staged.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ padding: "0 8px 4px", ...LABEL_STYLE }}>STAGED ({changes.staged.length})</div>
                  {renderChangeTree(visibleStagedChanges, "staged", stagedChangeTreeStatsByPath)}
                  {hiddenStagedChangeCount > 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, display: "flex", alignItems: "center", gap: 8 }}>
                      <span>Showing first {MAX_RENDERED_CHANGE_ROWS_PER_SECTION} of {changes.staged.length} staged files.</span>
                      <button
                        type="button"
                        onClick={() => setShowAllStagedChanges(true)}
                        style={{ color: COLORS.accent, fontSize: 11, fontFamily: MONO_FONT, cursor: "pointer" }}
                      >
                        Show all
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {changes.unstaged.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ padding: "0 8px 4px", ...LABEL_STYLE }}>UNSTAGED ({changes.unstaged.length})</div>
                  {renderChangeTree(visibleUnstagedChanges, "unstaged", unstagedChangeTreeStatsByPath)}
                  {hiddenUnstagedChangeCount > 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, display: "flex", alignItems: "center", gap: 8 }}>
                      <span>Showing first {MAX_RENDERED_CHANGE_ROWS_PER_SECTION} of {changes.unstaged.length} unstaged files.</span>
                      <button
                        type="button"
                        onClick={() => setShowAllUnstagedChanges(true)}
                        style={{ color: COLORS.accent, fontSize: 11, fontFamily: MONO_FONT, cursor: "pointer" }}
                      >
                        Show all
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {changes.staged.length === 0 && changes.unstaged.length === 0 ? (
                <div style={{ padding: 12, textAlign: "center", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, fontStyle: "italic" }}>
                  No changes
                </div>
              ) : null}
            </div>
            </>
            )}
          </SectionCard>

          <SectionCard
            title="History"
            description="Recent commits on this branch."
            dataTestId="history-section"
            sectionStyle={{ minHeight: 0, height: "100%" }}
            bodyStyle={{ flex: 1, minHeight: 0 }}
          >
            <div style={{ flex: 1, minHeight: 0 }}>
              <CommitTimeline
                laneId={laneId ?? null}
                selectedSha={selectedCommitSha}
                refreshTrigger={commitTimelineKey}
                hasUpstream={syncStatus?.hasUpstream ?? null}
                remoteMissing={upstreamMissing}
                onSelectCommit={(commit) => {
                  onSelectCommit(commit);
                }}
              />
            </div>
          </SectionCard>
        </div>
      </div>

      {(notice || error || busyAction) ? (
        <div
          className="shrink-0 flex items-center justify-between"
          style={{
            padding: "4px 16px",
            fontSize: 10,
            fontFamily: MONO_FONT,
            letterSpacing: "0.5px",
            borderTop: `1px solid ${COLORS.border}`,
            background: error ? "color-mix(in srgb, var(--color-error) 15%, transparent)" : "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            color: error ? COLORS.danger : COLORS.accent,
          }}
        >
          <span>
            {error ? `ERROR: ${error}` : notice ? notice.toUpperCase() : busyAction ? `RUNNING ${busyAction.toUpperCase()}...` : ""}
          </span>
        </div>
      ) : null}

      {textPrompt ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(460px, 100%)", background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO_FONT, letterSpacing: "1px", textTransform: "uppercase", color: COLORS.textPrimary }}>
              {textPrompt.title}
            </div>
            {textPrompt.message ? (
              <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                {textPrompt.message}
              </div>
            ) : null}
            <input
              autoFocus
              value={textPrompt.value}
              onChange={(event) => {
                const nextValue = event.target.value;
                setTextPrompt((prev) => (prev ? { ...prev, value: nextValue } : prev));
                if (textPromptError) setTextPromptError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelTextPrompt();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitTextPrompt();
                }
              }}
              placeholder={textPrompt.placeholder}
              style={{
                marginTop: 12,
                height: 36,
                width: "100%",
                padding: "0 12px",
                fontSize: 11,
                fontFamily: MONO_FONT,
                letterSpacing: "0.5px",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textSecondary,
                outline: "none",
              }}
            />
            {textPromptError ? (
              <div style={{ marginTop: 8, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.danger }}>
                {textPromptError}
              </div>
            ) : null}
            <div className="flex justify-end gap-2" style={{ marginTop: 16 }}>
              <button type="button" style={outlineButton({ height: 32, padding: "0 14px", fontSize: 10 })} onClick={cancelTextPrompt}>
                CANCEL
              </button>
              <button type="button" style={primaryButton({ height: 32, padding: "0 14px", fontSize: 10 })} onClick={submitTextPrompt}>
                {textPrompt.confirmLabel.toUpperCase()}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
