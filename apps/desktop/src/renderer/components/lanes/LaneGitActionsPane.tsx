import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { LaneDiffMode } from "../../../shared/types";
import { Archive, ArrowDown, ArrowLeft, ArrowsClockwise, ArrowUp, ArrowUUpLeft, CaretDown, CaretRight, Check, CheckCircle, DotsThree, Folder, GitBranch, GitCommit, Minus, Stack, Trash, X } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import {
  projectStateKeyForBinding,
  useAppStore,
} from "../../state/appStore";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { selectOtherMachineBranchStates, useLanesForPin } from "../../state/crossMachineLanes";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { plainLaneStartBranch } from "../../../shared/laneStart";
import { laneCompareBase } from "./laneRebaseNeeds";
import { isBranchDiffUnsupported } from "../../lib/branchDiffSupport";

const EMPTY_CROSS_MACHINE_LANES: Record<string, never> = {};
import { modifierKeyLabel } from "../../lib/platform";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { showToast } from "../app/toast/toastStore";
import { BranchIcon } from "../ui/vcsIcons";
import { PaneTooltip } from "../ui/PaneTooltip";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Z_LAYERS } from "../ui/zLayers";
import { SmartTooltip, type SmartTooltipContent } from "../ui/SmartTooltip";
import { confirmDialog, promptDialog } from "../ui/dialog/confirm";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_CHIP_WRAP,
  WORK_TOOL_CHROME_META,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_SECTION_LABEL_TEXT,
  WorkToolChromeButton,
} from "../terminals/workToolChrome";
import { COLORS, MONO_FONT, SANS_FONT } from "./laneDesignTokens";
import { CommitTimeline } from "./CommitTimeline";
import "./laneGitPane.css";
import {
  __resetLaneGitListCacheForTests,
  invalidateLaneGitListCache,
  isSameListResult,
  laneGitListEpoch,
  laneGitListScope,
  readLaneGitListCache,
  writeLaneGitListCache,
} from "./laneGitListCache";
import { LaneDiffPane } from "./LaneDiffPane";
import { PushDivergenceDialog } from "./PushDivergenceDialog";
import {
  detectPushDivergence,
  EMPTY_MACHINE_BRANCH_STATES,
  type DivergenceWarning,
  type MachineBranchState,
} from "../../../shared/laneDivergence";
import type {
  BranchDiffChanges,
  DiffChanges,
  FileChange,
  GitCommitSummary,
  GitConflictState,
  GitRecommendedAction,
  GitStashSummary,
  GitSyncMode,
  GitUpstreamSyncStatus,
  LaneSummary,
  OpenProjectBinding
} from "../../../shared/types";

type NextActionHint = {
  action: GitRecommendedAction | "resolve_conflicts";
  label: string;
  detail: string;
};

type ResponsiveMode = "narrow" | "medium" | "wide";

/** A push held back by the divergence guard, replayed verbatim on confirm. */
type PendingGuardedPush =
  | { kind: "push"; forceWithLease: boolean; warning: NonNullable<DivergenceWarning> }
  | { kind: "rebase-push"; confirmPublish: boolean; warning: NonNullable<DivergenceWarning> };

const MAX_RENDERED_CHANGE_ROWS_PER_SECTION = 300;
/** Files list rows are virtualized; the estimate stands in until each row is measured. */
const CHANGE_LIST_ROW_ESTIMATE_PX = 28;
/** The gaps the flex column put between rows and between the Staged and Unstaged sections. */
const CHANGE_LIST_ROW_GAP_PX = 2;
const CHANGE_LIST_SECTION_GAP_PX = 8;

export function formatLaneGitError(err: unknown, pin?: OpenProjectBinding | null): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const message = stripElectronErrorWrapper(raw);
  if (pin?.kind === "remote" && /connection closed/i.test(message)) {
    return "That machine disconnected. Stay on this chat or switch back to reconnect.";
  }
  return message || "Git action failed.";
}

type LaneGitActionsCachedState = {
  changes?: DiffChanges;
  stashes: GitStashSummary[];
  syncStatus: GitUpstreamSyncStatus | null;
  forcePushSuggested: boolean;
  conflictState: GitConflictState | null;
  stuckRebase: GitConflictState | null;
  updatedAtMs: number;
};

const EMPTY_CHANGES: DiffChanges = { unstaged: [], staged: [] };
const MAX_LANE_GIT_ACTIONS_CACHE_ENTRIES = 96;
const laneGitActionsStateByScope = new Map<string, LaneGitActionsCachedState>();

function laneGitActionsStateKey(projectKey: string | null | undefined, laneId: string | null): string | null {
  if (!laneId) return null;
  return `${projectKey?.trim() || "__project__"}::${laneId}`;
}

function readLaneGitActionsCachedState(
  projectKey: string | null | undefined,
  laneId: string | null,
): LaneGitActionsCachedState | null {
  const key = laneGitActionsStateKey(projectKey, laneId);
  if (!key) return null;
  const cached = laneGitActionsStateByScope.get(key) ?? null;
  if (!cached) return null;
  laneGitActionsStateByScope.delete(key);
  laneGitActionsStateByScope.set(key, cached);
  return cached;
}

function patchLaneGitActionsCachedState(
  projectKey: string | null | undefined,
  laneId: string | null,
  patch: Partial<Omit<LaneGitActionsCachedState, "updatedAtMs">>,
): LaneGitActionsCachedState | null {
  const key = laneGitActionsStateKey(projectKey, laneId);
  if (!key) return null;
  const previous = laneGitActionsStateByScope.get(key);
  const next: LaneGitActionsCachedState = {
    // A cleared entry keeps `changes` undefined: defaulting it back to the
    // empty placeholder would read as "changes already loaded" on the next mount.
    changes: previous ? previous.changes : EMPTY_CHANGES,
    stashes: previous?.stashes ?? [],
    syncStatus: previous?.syncStatus ?? null,
    forcePushSuggested: previous?.forcePushSuggested ?? false,
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

/**
 * Runs before every local git mutation on a lane. Drops the lane's cached
 * Branch diff, History and uncommitted changes, so a remount before the
 * post-mutation refresh lands shows the loading state and never the rows from
 * before the mutation.
 */
function invalidateLaneGitCaches(projectKey: string | null | undefined, laneId: string | null): void {
  invalidateLaneGitListCache(projectKey, laneId);
  const key = laneGitActionsStateKey(projectKey, laneId);
  const cached = key ? laneGitActionsStateByScope.get(key) : undefined;
  if (key && cached?.changes) {
    laneGitActionsStateByScope.set(key, { ...cached, changes: undefined, updatedAtMs: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Cross-machine branch state (push divergence guard)
// ---------------------------------------------------------------------------
//
// There is exactly one seam: the `otherMachineBranchStates` prop below. A
// module-global publish/subscribe registry used to sit here as a second path,
// relayed through the chat git toolbar, with no producer at either end — two
// delivery mechanisms for zero data. It is gone. When the renderer grows a
// cross-machine lane list, it fills the prop.

// Identity for the machine the renderer is running on, so the guard never
// warns about this machine. The id matches `laneMachines.ts` (THIS_MACHINE_ID)
// so a caller sourcing `others` from that module lines up without a
// translation step; display names come from `machineNameForBinding`. Machines
// are named absolutely — never "remote". Imported, not re-typed: the guard
// compares machine ids, so a drift here makes it warn that This computer
// diverged from itself.
import {
  THIS_MACHINE_ID as THIS_MACHINE_GUARD_ID,
  machineNameForBinding,
} from "../../../shared/machineIdentity";
import {
  beginLaneGitActionRuntime,
  clearLaneGitActionRuntimeState,
  patchLaneGitActionRuntimeState,
  patchLaneGitActionRuntimeStateIfCurrent,
  scheduleLaneGitActionRuntimeClear,
  useLaneGitActionRuntimeState,
} from "./laneGitActionRuntime";
import { toLayoutPx } from "../../lib/webZoom";
import { extractError } from "../../lib/format";

export {
  beginLaneGitActionRuntime,
  patchLaneGitActionRuntimeStateIfCurrent,
  scheduleLaneGitActionRuntimeClear,
  useLaneGitActionRuntimeState,
};

export function __resetLaneGitActionRuntimeForTests(): void {
  laneGitActionsStateByScope.clear();
  __resetLaneGitListCacheForTests();
  clearLaneGitActionRuntimeState();
}

function confirmForcePushWithLease(): Promise<boolean> {
  return confirmDialog({
    title: "Force push with lease?",
    message: "This overwrites the remote branch with your local history. Only use this if you intend to publish rewritten commits.",
    confirmLabel: "Force push",
    destructive: true,
  });
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

/**
 * One row of the Files list in display order. The tree is folded into rows so
 * the list can be virtualized: a collapsed folder's children never enter the
 * list, and only the rows in view mount.
 */
type ChangeListRow =
  | { key: string; kind: "section"; label: string; count: number; gapAbove: boolean }
  | { key: string; kind: "folder"; mode: LaneDiffMode; name: string; depth: number; collapsed: boolean; stats: ChangeTreeStats }
  | { key: string; kind: "file"; mode: LaneDiffMode; file: FileChange; depth: number }
  | { key: string; kind: "notice"; section: ChangeSection; total: number; noun: string };

function flattenChangeTreeRows(
  node: ChangeTreeNode,
  mode: LaneDiffMode,
  depth: number,
  collapsedFolders: ReadonlySet<string>,
  statsByPath: Map<string, ChangeTreeStats>,
  rows: ChangeListRow[],
): void {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

  for (const dir of dirs) {
    const key = `${mode}:${dir.path}`;
    const collapsed = collapsedFolders.has(key);
    const stats = statsByPath.get(dir.path) ?? getChangeTreeStats(dir);
    rows.push({ key, kind: "folder", mode, name: dir.name, depth, collapsed, stats });
    if (!collapsed) flattenChangeTreeRows(dir, mode, depth + 1, collapsedFolders, statsByPath, rows);
  }

  for (const file of files) {
    rows.push({ key: `${mode}:wrap:${file.path}`, kind: "file", mode, file, depth });
  }
}

/** Index of the next row after `from` that has a control Tab can stop on, or -1 at the end of the list. */
function nextChangeListRowWithControls(rows: ChangeListRow[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];
    // Section labels and branch file rows are plain text; folders, notices and uncommitted file rows hold buttons.
    if (row && (row.kind === "folder" || row.kind === "notice" || (row.kind === "file" && row.mode !== "branch"))) return index;
  }
  return -1;
}

/** One row of the "More git actions" menu: icon, sentence-case label, optional badge. */
function ActionButton({
  title,
  detail,
  onClick,
  disabled,
  badge,
  icon,
  tone = "default",
  smartTooltip,
}: {
  title: string;
  detail: string;
  onClick: () => void;
  disabled: boolean;
  badge?: string | null;
  icon?: React.ReactNode;
  /** `caution` for actions that rewrite shared history (force push); `danger` for ones that throw work away (discard). */
  tone?: "default" | "caution" | "danger";
  smartTooltip?: SmartTooltipContent;
}) {
  const color = tone === "caution" ? "var(--color-warning)" : tone === "danger" ? COLORS.danger : COLORS.textPrimary;
  const button = (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={`${title}. ${detail}`}
      className="hover:bg-fg/[0.06]"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        height: 30,
        padding: "0 10px",
        borderRadius: 6,
        background: "transparent",
        color,
        fontFamily: SANS_FONT,
        fontSize: 12,
        textAlign: "left",
        whiteSpace: "nowrap",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        ...(disabled ? { pointerEvents: "none" as const } : {}),
      }}
    >
      <span style={{ display: "inline-flex", width: 14, flexShrink: 0, opacity: tone === "default" ? 0.55 : 0.9 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
      {badge ? <span className="kit-tag" data-tone="warn">{badge}</span> : null}
    </button>
  );
  const wrapped = disabled ? <span title={`${title}. ${detail}`} style={{ display: "block" }}>{button}</span> : button;
  return smartTooltip ? <SmartTooltip content={smartTooltip}>{wrapped}</SmartTooltip> : wrapped;
}

type ChangeSection = "staged" | "unstaged" | "branch";

/** "Showing first N of M files. Show all" under a capped change list. */
function TruncatedChangesNotice({ total, noun, onShowAll }: { total: number; noun: string; onShowAll: () => void }) {
  return (
    <div className="ade-git-truncated">
      <span>Showing first {MAX_RENDERED_CHANGE_ROWS_PER_SECTION} of {total} {noun} files.</span>
      <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" onClick={onShowAll}>
        Show all
      </button>
    </div>
  );
}

/**
 * One section's file list. It is as tall as its rows up to the section's cap,
 * then scrolls on its own, so Uncommitted and Committed never push each other
 * or History off the pane. Rows are virtualized: a lane far from its base can
 * list thousands of files.
 */
function ChangeList({
  rows,
  renderRow,
  testId,
}: {
  rows: ChangeListRow[];
  renderRow: (row: ChangeListRow) => React.ReactNode;
  testId: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row that holds keyboard focus, as state: moving focus re-renders the window so the rows Tab can reach next are mounted.
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const focusedIndex = focusedRowKey == null ? -1 : rows.findIndex((row) => row.key === focusedRowKey);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: () => CHANGE_LIST_ROW_ESTIMATE_PX,
    overscan: 4,
    gap: CHANGE_LIST_ROW_GAP_PX,
    // Tab moves focus in the browser's own order and does not wait for a scroll to mount the next row, so the rows
    // it can land on are mounted here: the focused row (it keeps focus when it scrolls out of view) and the nearest
    // row with controls on each side. Rows in between hold no controls, so Tab never needs them.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < 0) return indexes;
      const reachable = [
        focusedIndex,
        nextChangeListRowWithControls(rows, focusedIndex, 1),
        nextChangeListRowWithControls(rows, focusedIndex, -1),
      ].filter((index) => index >= 0 && !indexes.includes(index));
      return reachable.length === 0 ? indexes : [...indexes, ...reachable].sort((a, b) => a - b);
    },
  });

  return (
    <div
      ref={scrollRef}
      className="ade-git-list"
      data-testid={testId}
      // Focus landing in a row mounts its neighbours before the next Tab. Focus leaving the list releases them.
      onFocus={(event) => {
        const index = Number((event.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index);
        setFocusedRowKey(rows[index]?.key ?? null);
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocusedRowKey(null);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={row.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                paddingTop: row.kind === "section" && row.gapAbove ? CHANGE_LIST_SECTION_GAP_PX - CHANGE_LIST_ROW_GAP_PX : undefined,
              }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LaneGitActionsPane({
  laneId,
  active = true,
  onRebaseNowLocal,
  onRebaseAndPush,
  onViewRebaseDetails,
  compareBase = null,
  onSelectFile,
  onSelectCommit,
  onClearDiffSelection,
  selectedPath,
  selectedMode,
  selectedCommit = null,
  selectedCommitSha,
  otherMachineBranchStates = EMPTY_MACHINE_BRANCH_STATES,
  currentMachineName,
  currentMachineId,
  currentMachineHeadSha = null,
  runtimePin = null,
}: {
  laneId: string | null;
  active?: boolean;
  onRebaseNowLocal?: (laneId: string) => Promise<void> | void;
  onRebaseAndPush?: (laneId: string) => Promise<void> | void;
  onViewRebaseDetails?: (laneId?: string | null) => void;
  /**
   * The branch this lane rebases onto (`laneCompareBase`: the brain's compare
   * base). Unset reads it from the lane.
   */
  compareBase?: string | null;
  onSelectFile: (path: string, mode: LaneDiffMode) => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  /** Clears file + commit diff selection (back to file list in this section). */
  onClearDiffSelection?: () => void;
  selectedPath: string | null;
  selectedMode: LaneDiffMode | null;
  /** Defaults to null when omitted (e.g. floating pane / legacy call sites). */
  selectedCommit?: GitCommitSummary | null;
  selectedCommitSha: string | null;
  /**
   * Other machines known to hold this lane's branch, built with
   * `toMachineBranchState` from lane records the renderer already has
   * (`LaneListSnapshot` / `lane_state_snapshots`). The single seam into the
   * push guard — there is no registry, no publisher, no second path.
   *
   * Optional override. When unset the guard reads the cross-machine lane union
   * (`selectOtherMachineBranchStates`) at click time, so it costs nothing until
   * you press push and never re-renders this pane. The guard also
   * short-circuits on an empty list, keeping the single-machine path free.
   */
  otherMachineBranchStates?: readonly MachineBranchState[];
  /** Absolute name for this machine in guard copy. Never "remote". */
  currentMachineName?: string;
  currentMachineId?: string;
  /** This machine's head commit, when a caller knows it. Unknown is fine. */
  currentMachineHeadSha?: string | null;
  /**
   * Machine this lane actually lives on. `null` (the default, and every
   * pre-existing call site) means the tab's bound machine. When set, every
   * git/diff read and write is routed there instead, and the panel's cached
   * state is keyed on the pin so a tab switch never shows another machine's
   * changes.
   */
  runtimePin?: OpenProjectBinding | null;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  // Cross-machine lane union, produced by `crossMachineLanes`. Feeds the push
  // divergence guard below; the slice is reference-stable while unchanged.
  const crossMachineLanesByMachineId = useAppStore((s) => s.crossMachineLanesByMachineId ?? EMPTY_CROSS_MACHINE_LANES);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const pin = runtimePin ?? null;
  // Lane ids are only unique per machine, so a pinned panel gets its own cache
  // namespace. Always key through `projectStateKeyForBinding` of the effective
  // session machine: local stays on the checkout path across a bound→pinned
  // flip, remote stays on `binding.key`. Comparing `pin.key` to the tab key
  // used `local:${path}` once the pin stuck and emptied the cache.
  const projectStateKey = projectStateKeyForBinding(
    effectiveRuntimeBinding(pin, projectBinding),
    projectRoot,
  );

  // A foreign lane is absent from the local `lanes` array; resolve it against
  // the pinned machine's own slice of the cross-machine union. Never against
  // `lanes` — that is the TAB's machine, and lane ids are unique only per
  // machine, so falling back there can match a different machine's lane and
  // drive git on the wrong checkout.
  const pinnedMachineLanes = useLanesForPin(pin);
  const pinnedLanes: LaneSummary[] = pinnedMachineLanes ?? lanes;

  const lane = useMemo(() => pinnedLanes.find((entry) => entry.id === laneId) ?? null, [pinnedLanes, laneId]);

  const rootRef = useRef<HTMLDivElement>(null);
  const currentLaneIdRef = useRef<string | null>(laneId);
  const [paneWidth, setPaneWidth] = useState(1024);
  const initialCachedGitState = readLaneGitActionsCachedState(projectStateKey, laneId);
  const listScope = laneGitListScope(projectStateKey, laneId);
  const listBranchRef = lane?.branchRef ?? null;

  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>(initialCachedGitState?.changes ?? EMPTY_CHANGES);
  // The lane whose `changes` are a real read (cached or fetched), not the empty
  // placeholder a lane opens with. The branch diff waits for it.
  const [changesReadyForLane, setChangesReadyForLane] = useState<string | null>(
    initialCachedGitState?.changes ? laneId : null,
  );
  // Bumped whenever the pane (re)loads a lane: becoming active again, or the
  // lane's branch moving. A commit made elsewhere leaves a clean tree clean, so
  // the change signature alone would not re-read the branch diff then.
  const [branchReadNonce, setBranchReadNonce] = useState(0);
  const [commitMessage, setCommitMessage] = useState("");
  const syncMode: GitSyncMode = "merge";
  const [stashes, setStashes] = useState<GitStashSummary[]>(initialCachedGitState?.stashes ?? []);
  const [syncStatus, setSyncStatus] = useState<GitUpstreamSyncStatus | null>(initialCachedGitState?.syncStatus ?? null);
  const [forcePushSuggested, setForcePushSuggested] = useState(initialCachedGitState?.forcePushSuggested ?? false);
  const [commitTimelineKey, setCommitTimelineKey] = useState(0);
  // Committed on this branch: the files the lane's commits changed since it
  // left its base. Shown under the uncommitted changes, never instead of them.
  const [branchChanges, setBranchChanges] = useState<BranchDiffChanges | null>(null);
  // The branch read effect writes its result under the lane and branch the read
  // was started for. Kept in a ref, not deps: a branch change already re-runs
  // that effect through `branchReadNonce`, so it must not add a second trigger.
  const listCacheTargetRef = useRef({ scope: listScope, branchRef: listBranchRef });
  listCacheTargetRef.current = { scope: listScope, branchRef: listBranchRef };
  // True while the Branch rows on screen came from the cache and no read has
  // confirmed them yet. A failed read then clears them instead of leaving
  // unconfirmed rows beside its error.
  const branchFromCacheRef = useRef(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchSupported, setBranchSupported] = useState(() => typeof window.ade?.diff?.getBranchChanges === "function");
  const [amendCommit, setAmendCommit] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** The Uncommitted section's own menu: unstage, discard, new lane. */
  const [showUncommittedMenu, setShowUncommittedMenu] = useState(false);
  const uncommittedMenuTriggerRef = useRef<HTMLSpanElement>(null);
  /** The branch stashes strip, opened from the "More git actions" menu. */
  const [showStashes, setShowStashes] = useState(false);
  const advancedTriggerRef = useRef<HTMLSpanElement>(null);
  const [conflictState, setConflictState] = useState<GitConflictState | null>(initialCachedGitState?.conflictState ?? null);
  const [stuckRebase, setStuckRebase] = useState<GitConflictState | null>(initialCachedGitState?.stuckRebase ?? null);
  const [pendingPush, setPendingPush] = useState<PendingGuardedPush | null>(null);
  const laneGitActionScopeKey = laneGitActionsStateKey(projectStateKey, laneId);
  const laneGitActionRuntime = useLaneGitActionRuntimeState(laneGitActionScopeKey);
  const busyAction = laneGitActionRuntime.busyAction;
  const notice = laneGitActionRuntime.notice;
  const error = laneGitActionRuntime.error;

  const stagedCount = changes.staged.length;
  const hasStaged = stagedCount > 0;
  const hasUnstaged = changes.unstaged.length > 0;
  const hasUntrackedChanges = changes.unstaged.some((file) => file.kind === "untracked");
  // "Show all" holds for one lane on one machine (lane ids are unique only per
  // machine); another lane or machine starts capped again.
  const showAllScope = `${projectStateKey}\u0000${laneId ?? ""}`;
  const [showAllChoice, setShowAllChoice] = useState<{ scope: string; sections: readonly ChangeSection[] }>({ scope: "", sections: [] });
  const showAllSection = (section: ChangeSection) =>
    setShowAllChoice((prev) => ({
      scope: showAllScope,
      sections: prev.scope === showAllScope ? [...prev.sections, section] : [section],
    }));
  const isShowingAll = (section: ChangeSection) =>
    showAllChoice.scope === showAllScope && showAllChoice.sections.includes(section);
  const showAllStagedChanges = isShowingAll("staged");
  const showAllUnstagedChanges = isShowingAll("unstaged");
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
  const branchChangeTreeStatsByPath = useMemo(() => buildChangeTreeStatsByPath(branchChanges?.files ?? []), [branchChanges]);
  // The committed list holds every file since the merge base, which on a lane far
  // from its base is thousands: all of them mounted at once was a ~1 s freeze
  // opening Lanes. Same cap as the uncommitted sections.
  const showAllBranchChanges = isShowingAll("branch");
  const visibleBranchChanges = useMemo(() => {
    const files = branchChanges?.files ?? [];
    if (showAllBranchChanges || files.length <= MAX_RENDERED_CHANGE_ROWS_PER_SECTION) return files;
    return [...files].sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_RENDERED_CHANGE_ROWS_PER_SECTION);
  }, [branchChanges, showAllBranchChanges]);
  const hiddenBranchChangeCount = Math.max(0, (branchChanges?.files.length ?? 0) - visibleBranchChanges.length);
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
    setPaneWidth(node.clientWidth || toLayoutPx(window.innerWidth));
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
    }): Promise<string | null> =>
      promptDialog({
        title: args.title,
        message: args.message,
        placeholder: args.placeholder,
        defaultValue: args.defaultValue,
        confirmLabel: args.confirmLabel ?? "Confirm",
        // Empty is a valid answer (an optional stash note); a caller that needs
        // text says so in `validate`.
        allowEmpty: true,
        validate: (value) => args.validate?.(value.trim()) ?? null,
      }).then((value) => value?.trim() ?? null),
    []
  );

  const refreshChanges = async (targetLaneId: string | null = laneId) => {
    if (!targetLaneId) return;
    const hasCachedState = Boolean(readLaneGitActionsCachedState(projectStateKey, targetLaneId));
    if (isViewingLane(targetLaneId) && !hasCachedState) setLoading(true);
    const epochAtStart = laneGitListEpoch();
    try {
      const next = await window.ade.diff.getChanges({ laneId: targetLaneId }, pin);
      // A mutation that started while this read was in flight may have
      // cleared the lane's cache after the read began: that result is not cached.
      if (epochAtStart === laneGitListEpoch()) {
        patchLaneGitActionsCachedState(projectStateKey, targetLaneId, { changes: next });
      }
      if (isViewingLane(targetLaneId)) {
        setChanges((prev) => (isSameListResult(prev, next) ? prev : next));
      }
    } finally {
      // A failed read still ends the wait: the committed list reads on its own
      // instead of showing "Reading commits…" for good.
      if (isViewingLane(targetLaneId)) setChangesReadyForLane(targetLaneId);
      if (isViewingLane(targetLaneId) && !hasCachedState) {
        setLoading(false);
      }
    }
  };

  const refreshGitMeta = async (targetLaneId: string | null = laneId) => {
    if (!targetLaneId) return;
    const [stashesResult, syncStatusResult, conflictResult] = await Promise.allSettled([
      window.ade.git.stashList({ laneId: targetLaneId }, pin),
      window.ade.git.getSyncStatus({ laneId: targetLaneId }, pin),
      window.ade.git.getConflictState(targetLaneId, pin)
    ]);

    const stashes = stashesResult.status === "fulfilled" ? stashesResult.value : undefined;
    const nextSyncStatus = syncStatusResult.status === "fulfilled" ? syncStatusResult.value : null;
    const nextConflictState = conflictResult.status === "fulfilled" ? conflictResult.value : null;
    patchLaneGitActionsCachedState(projectStateKey, targetLaneId, {
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
      // The global lane store belongs to the tab's bound machine. Refreshing it
      // after a foreign lane's git action would be work for the wrong machine.
      pin ? Promise.resolve() : refreshLanes({ includeStatus: true, includeSnapshots: false }),
      refreshGitMeta(targetLaneId),
    ]);
  }, [pin, refreshChanges, refreshGitMeta, refreshLanes]);

  const refreshAll = async (options?: { fetchRemote?: boolean }, targetLaneId: string | null = laneId) => {
    if (targetLaneId && options?.fetchRemote) {
      try {
        await window.ade.git.fetch({ laneId: targetLaneId }, pin);
      } catch {
        // best effort
      }
    }
    await refreshLaneGitState(targetLaneId);
    if (isViewingLane(targetLaneId)) {
      setCommitTimelineKey((prev) => prev + 1);
    }
  };

  useEffect(() => {
    setShowAdvanced(false);
    setShowUncommittedMenu(false);
    setShowStashes(false);
  }, [laneId]);

  const hasUncommittedChanges = hasStaged || hasUnstaged;
  // Each section is one virtualized list of its section labels, folders, files
  // and notices, so the gap between Staged and Unstaged is padding on the
  // Unstaged label rather than a second scroller.
  const uncommittedRows = useMemo(() => {
    const rows: ChangeListRow[] = [];
    if (changes.staged.length > 0) {
      rows.push({ key: "staged:label", kind: "section", label: "Staged", count: changes.staged.length, gapAbove: false });
      flattenChangeTreeRows(buildChangeTree(visibleStagedChanges), "staged", 0, collapsedChangeFolders, stagedChangeTreeStatsByPath, rows);
      if (hiddenStagedChangeCount > 0) {
        rows.push({ key: "staged:notice", kind: "notice", section: "staged", total: changes.staged.length, noun: "staged" });
      }
    }
    if (changes.unstaged.length > 0) {
      rows.push({ key: "unstaged:label", kind: "section", label: "Unstaged", count: changes.unstaged.length, gapAbove: changes.staged.length > 0 });
      flattenChangeTreeRows(buildChangeTree(visibleUnstagedChanges), "unstaged", 0, collapsedChangeFolders, unstagedChangeTreeStatsByPath, rows);
      if (hiddenUnstagedChangeCount > 0) {
        rows.push({ key: "unstaged:notice", kind: "notice", section: "unstaged", total: changes.unstaged.length, noun: "unstaged" });
      }
    }
    return rows;
  }, [
    changes.staged,
    changes.unstaged,
    visibleStagedChanges,
    stagedChangeTreeStatsByPath,
    hiddenStagedChangeCount,
    visibleUnstagedChanges,
    unstagedChangeTreeStatsByPath,
    hiddenUnstagedChangeCount,
    collapsedChangeFolders,
  ]);
  const committedRows = useMemo(() => {
    const rows: ChangeListRow[] = [];
    if (branchChanges && branchChanges.files.length > 0) {
      flattenChangeTreeRows(buildChangeTree(visibleBranchChanges), "branch", 0, collapsedChangeFolders, branchChangeTreeStatsByPath, rows);
      if (hiddenBranchChangeCount > 0) {
        rows.push({ key: "branch:notice", kind: "notice", section: "branch", total: branchChanges.files.length, noun: "committed" });
      }
    }
    return rows;
  }, [branchChanges, visibleBranchChanges, branchChangeTreeStatsByPath, hiddenBranchChangeCount, collapsedChangeFolders]);

  useEffect(() => {
    setBranchChanges(null);
    setBranchError(null);
  }, [laneId]);

  // Re-read on every refresh of history (`commitTimelineKey`) and when a path
  // leaves or joins the staged or unstaged lists: a commit made outside ADE (an
  // agent's terminal) shows up first as files leaving those lists. Keyed on the
  // paths alone, so an edit to a file that is already dirty, the common case
  // while an agent works, does not re-read the branch. Wait for the first real
  // read, so opening a lane reads the branch diff once. Also wait for the load
  // below to bump `branchReadNonce`: with cached changes this effect would
  // otherwise read on mount and again a moment later.
  const changedPathsSignature = useMemo(
    () => [changes.staged, changes.unstaged].map((files) => files.map((file) => file.path).join("\u0000")).join("\u0001"),
    [changes],
  );
  const changesReady = changesReadyForLane != null && changesReadyForLane === laneId;
  useEffect(() => {
    if (!branchSupported || !laneId || !changesReady || branchReadNonce === 0) return;
    const getBranchChanges = window.ade?.diff?.getBranchChanges;
    if (!getBranchChanges) return;
    let cancelled = false;
    const { scope, branchRef } = listCacheTargetRef.current;
    const epochAtStart = laneGitListEpoch();
    getBranchChanges({ laneId }, pin)
      .then((result) => {
        if (cancelled) return;
        // Null is a host that predates branch diffs: the committed section hides.
        if (result == null) {
          setBranchSupported(false);
          return;
        }
        writeLaneGitListCache(scope, epochAtStart, branchRef, { branchChanges: result });
        branchFromCacheRef.current = false;
        setBranchChanges((prev) => (isSameListResult(prev, result) ? prev : result));
        setBranchError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (branchFromCacheRef.current) {
          branchFromCacheRef.current = false;
          setBranchChanges(null);
        }
        if (isBranchDiffUnsupported(error)) setBranchSupported(false);
        else setBranchError(stripElectronErrorWrapper(extractError(error)));
      });
    return () => {
      cancelled = true;
    };
  }, [branchReadNonce, branchSupported, changedPathsSignature, changesReady, commitTimelineKey, laneId, pin]);


  // Only git's own `[rejected] … (non-fast-forward)` / `(fetch first)` refusal
  // means the remote history moved. Every refused push also prints "failed to
  // push some refs", including hook, branch-rule and credential refusals, where
  // a force push cannot help and the host's message already says why.
  const isNonFastForwardError = useCallback((rawMessage: string): boolean => {
    return /non-fast-forward|\(fetch first\)/i.test(rawMessage);
  }, []);

  const formatActionError = useCallback((actionName: string, rawMessage: string): string => {
    const message = stripElectronErrorWrapper(rawMessage);
    if ((actionName === "push" || actionName === "force push") && isNonFastForwardError(message)) {
      return "Push rejected because remote history changed. Use Force Push (lease) after a rebase, amend, or other rewritten history.";
    }
    return formatLaneGitError(message, pin);
  }, [isNonFastForwardError, pin]);

  const runAction = async (actionName: string, fn: () => Promise<void>) => {
    const actionLaneId = laneId;
    if (!actionLaneId) return;
    const actionScopeKey = laneGitActionsStateKey(projectStateKey, actionLaneId);
    const actionVersion = beginLaneGitActionRuntime(actionScopeKey, {
      busyAction: actionName,
      notice: null,
      error: null,
    });
    try {
      // A read that started while the mutation ran may have seen the pre-mutation repo: drop what it cached before the refresh.
      await fn().finally(() => invalidateLaneGitCaches(projectStateKey, actionLaneId));
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
        patchLaneGitActionsCachedState(projectStateKey, actionLaneId, { forcePushSuggested: false });
      }
      patchLaneGitActionRuntimeStateIfCurrent(actionScopeKey, actionVersion, {
        busyAction: null,
        notice: `${actionName} completed`,
        error: null,
      });
      // Global success toast for remote push/sync completion (the inline notice
      // above is subtle and auto-clears in 3s). Errors keep the persistent
      // inline banner below and are intentionally not re-toasted.
      const laneLabel = lane?.name ?? actionLaneId;
      if (actionName === "push") {
        showToast({ title: `Pushed ${laneLabel}`, tone: "success" });
      } else if (actionName === "force push") {
        showToast({ title: `Force-pushed ${laneLabel}`, tone: "success" });
      } else if (actionName === "pull") {
        // A pull that stops on merge/rebase conflicts still resolves (the git
        // service treats detected conflicts as a completed operation), so check
        // conflict state before claiming success.
        const postPullConflicts = await window.ade.git.getConflictState(actionLaneId, pin).catch(() => null);
        if (postPullConflicts?.inProgress) {
          showToast({
            title: laneLabel,
            message: `Pull stopped on ${postPullConflicts.kind === "merge" ? "merge" : "rebase"} conflicts — resolve them to finish.`,
            tone: "error",
          });
        } else {
          showToast({ title: `Pulled ${laneLabel}`, tone: "success" });
        }
      } else if (actionName === "rebase and push") {
        showToast({ title: `Rebased & pushed ${laneLabel}`, tone: "success" });
      }
      scheduleLaneGitActionRuntimeClear(actionScopeKey, actionVersion, 3_000, {
        notice: null,
      });
    } catch (err) {
      const message = extractError(err);
      if (message === "__ade_cancelled__") {
        patchLaneGitActionRuntimeStateIfCurrent(actionScopeKey, actionVersion, {
          busyAction: null,
          notice: null,
          error: null,
        });
        return;
      }
      if (actionName === "push" && isNonFastForwardError(message)) {
        patchLaneGitActionsCachedState(projectStateKey, actionLaneId, { forcePushSuggested: true });
        if (isViewingLane(actionLaneId)) {
          setForcePushSuggested(true);
        }
      }
      patchLaneGitActionRuntimeStateIfCurrent(actionScopeKey, actionVersion, {
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
    if (!message.length) {
      patchLaneGitActionRuntimeState(laneGitActionScopeKey, {
        notice: null,
        error: "Type a commit message, then commit.",
      });
      return;
    }
    void runAction(amendCommit ? "amend commit" : "commit", async () => {
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.commit({ laneId, message, amend: amendCommit }, pin);
      await completeCommitRefresh(laneId);
    });
  }, [
    amendCommit,
    busyAction,
    commitMessage,
    completeCommitRefresh,
    hasStaged,
    laneGitActionScopeKey,
    laneId,
    projectStateKey,
  ]);

  useEffect(() => {
    const cached = readLaneGitActionsCachedState(projectStateKey, laneId);
    const cachedList = readLaneGitListCache(listScope, listBranchRef);
    setLoading(false);
    setChanges(cached?.changes ?? EMPTY_CHANGES);
    setChangesReadyForLane(cached?.changes ? laneId : null);
    // The cached Branch diff paints in a transition, so the first commit of a
    // revisit is the same cheap shell a cold mount paints. Fresh data is queued
    // later by the read's own `.then`, so it still lands last.
    branchFromCacheRef.current = cachedList?.branchChanges != null;
    startTransition(() => setBranchChanges(cachedList?.branchChanges ?? null));
    setStashes(cached?.stashes ?? []);
    setSyncStatus(cached?.syncStatus ?? null);
    setForcePushSuggested(cached?.forcePushSuggested ?? false);
    setCollapsedChangeFolders(new Set());
    setAmendCommit(false);
    setConflictState(cached?.conflictState ?? null);
    setStuckRebase(cached?.stuckRebase ?? null);
    if (!active || !laneId) return;
    setBranchReadNonce((value) => value + 1);
    Promise.all([refreshChanges(laneId), refreshGitMeta(laneId)]).catch((err) => {
      patchLaneGitActionRuntimeState(laneGitActionScopeKey, {
        notice: null,
        error: formatLaneGitError(err, pin),
      });
    });
  }, [active, laneGitActionScopeKey, laneId, listBranchRef, listScope, pin, projectStateKey]);

  useEffect(() => {
    if (!active || !laneId) return;
    let refreshTimer: number | null = null;
    const effectLaneId = laneId;
    const refreshSyncStatus = () => {
      void window.ade.git
        .getSyncStatus({ laneId: effectLaneId }, pin)
        .then((nextStatus) => {
          patchLaneGitActionsCachedState(projectStateKey, effectLaneId, { syncStatus: nextStatus });
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
  }, [active, isViewingLane, laneId, pin, projectStateKey]);

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
        ? "Finish the current merge before copying changes to a new lane."
        : "Finish the current rebase before copying changes to a new lane.";
    }
    if (!hasStaged && !hasUnstaged) return "This lane has no uncommitted changes to copy.";
    return "Create a new lane from this lane's branch with a copy of its uncommitted changes. This lane keeps them.";
  }, [busyAction, conflictState, hasStaged, hasUnstaged, laneId]);

  const rescueButtonDisabled = !laneId || busyAction != null || (!hasStaged && !hasUnstaged) || Boolean(conflictState?.inProgress);

  const stagedPathSet = useMemo(() => new Set(changes.staged.map((file) => file.path)), [changes.staged]);
  const unstagedPathSet = useMemo(() => new Set(changes.unstaged.map((file) => file.path)), [changes.unstaged]);

  const toggleStageFile = async (path: string, isStaged: boolean) => {
    if (!laneId) return;
    invalidateLaneGitCaches(projectStateKey, laneId);
    try {
      if (isStaged) {
        await window.ade.git.unstageFile({ laneId, path }, pin);
      } else {
        await window.ade.git.stageFile({ laneId, path }, pin);
      }
    } finally {
      // A read that started while the mutation ran may have seen the pre-mutation index.
      invalidateLaneGitCaches(projectStateKey, laneId);
    }
    await refreshChanges();
  };

  const discardFile = async (path: string) => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = await confirmDialog({
      title: `Discard all changes to ${path}?`,
      message: "This cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (!ok) return;
    void runAction("discard file", async () => {
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.discardFile({ laneId, path }, pin);
    });
  };

  const discardStagedFile = async (path: string) => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = await confirmDialog({
      title: `Discard staged and unstaged changes to ${path}?`,
      message: "This cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (!ok) return;
    void runAction("discard staged file", async () => {
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.restoreStagedFile({ laneId, path }, pin);
    });
  };

  const discardAll = async () => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = await confirmDialog({
      title: `Discard all unstaged changes (${changes.unstaged.length} file${changes.unstaged.length === 1 ? "" : "s"})?`,
      message: "This cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (!ok) return;
    void runAction("discard all", async () => {
      for (const file of changes.unstaged) {
        invalidateLaneGitCaches(projectStateKey, laneId);
        await window.ade.git.discardFile({ laneId, path: file.path }, pin);
      }
    });
  };

  const discardAllStaged = async () => {
    if (!laneId) return;
    if (busyAction) return;
    const ok = await confirmDialog({
      title: `Discard all staged changes (${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"})?`,
      message: "This also discards any unstaged edits to the same files and cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (!ok) return;
    void runAction("discard staged files", async () => {
      for (const file of changes.staged) {
        invalidateLaneGitCaches(projectStateKey, laneId);
        await window.ade.git.restoreStagedFile({ laneId, path: file.path }, pin);
      }
    });
  };

  const stageAll = () => {
    if (!laneId) return;
    void runAction("stage all", async () => {
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.stageAll({ laneId, paths: changes.unstaged.map((file) => file.path) }, pin);
    });
  };

  const newLaneWithChanges = useCallback(async () => {
    if (!laneId || busyAction != null) return;
    if (!hasStaged && !hasUnstaged) {
      patchLaneGitActionRuntimeState(laneGitActionScopeKey, {
        notice: null,
        error: "This lane has no uncommitted changes to copy.",
      });
      return;
    }
    if (conflictState?.inProgress) {
      const kindLabel = conflictState.kind === "merge" ? "merge" : "rebase";
      patchLaneGitActionRuntimeState(laneGitActionScopeKey, {
        notice: null,
        error: `Finish the current ${kindLabel} before copying changes to a new lane.`,
      });
      return;
    }
    let branch = plainLaneStartBranch(lane?.branchRef);
    if (!branch) {
      // A lane on another machine may not be in this window's lists yet; ask
      // its own machine.
      let machineLanes: LaneSummary[];
      try {
        machineLanes = await window.ade.lanes.list({ includeStatus: false }, pin);
      } catch (err) {
        console.warn("lane_git_actions.branch_lookup_failed", { laneId, pinned: Boolean(pin), error: err });
        patchLaneGitActionRuntimeState(laneGitActionScopeKey, {
          notice: null,
          error: `ADE couldn't read which branch this lane is on: ${formatLaneGitError(err, pin)}`,
        });
        return;
      }
      branch = plainLaneStartBranch(machineLanes.find((entry) => entry.id === laneId)?.branchRef);
    }
    if (!branch) {
      patchLaneGitActionRuntimeState(laneGitActionScopeKey, {
        notice: null,
        error: "This lane is not on a branch, so a new lane cannot start from it.",
      });
      return;
    }

    const name = await requestTextInput({
      title: "New lane with these changes",
      message: `Start a new lane from ${branch} with a copy of the uncommitted changes (staged, unstaged and untracked). This lane keeps its changes.`,
      placeholder: "e.g. feature/rescue-work",
      confirmLabel: "Create lane",
      validate: (value) => (value.trim().length ? null : "Lane name is required."),
    });
    if (name == null) return;

    const actionLaneId = laneId;
    const actionScopeKey = laneGitActionsStateKey(projectStateKey, actionLaneId);
    const actionVersion = beginLaneGitActionRuntime(actionScopeKey, {
      busyAction: "new lane with changes",
      notice: null,
      error: null,
    });
    try {
      // Made on this lane's machine: the copy reads this lane's folder.
      const created = await window.ade.lanes.create(
        { name: name.trim(), start: { from: "branch", branch, on: "uncommitted" } },
        pin,
      );
      // The lane is made even when the copy did not apply (or a fallback was
      // taken); say so instead of claiming the changes came along.
      const notes = created.createdFrom?.notes ?? [];
      const copiedNothing = created.createdFrom?.copiedFiles === 0;
      const warned = copiedNothing || notes.length > 0;
      if (warned) {
        showToast({
          title: `${created.name} was created`,
          message: notes.length > 0 ? notes.join(" ") : "No uncommitted changes were copied into it.",
          tone: "warning",
        });
      }
      if (pin) {
        // The new lane lives on the lane's machine, not in this tab's lane
        // list or Lanes page, so stay here; it appears in that machine's list.
        patchLaneGitActionRuntimeStateIfCurrent(actionScopeKey, actionVersion, {
          busyAction: null,
          notice: warned ? null : `Created ${created.name} with a copy of these changes.`,
          error: null,
        });
        return;
      }
      patchLaneGitActionRuntimeStateIfCurrent(actionScopeKey, actionVersion, {
        busyAction: null,
        notice: null,
        error: null,
      });
      await refreshLanes();
      selectLane(created.id);
      navigate(`/lanes?laneId=${encodeURIComponent(created.id)}&focus=single`);
    } catch (err) {
      patchLaneGitActionRuntimeStateIfCurrent(actionScopeKey, actionVersion, {
        busyAction: null,
        notice: null,
        error: formatLaneGitError(err, pin),
      });
    }
  }, [
    busyAction,
    conflictState,
    hasStaged,
    hasUnstaged,
    laneGitActionScopeKey,
    laneId,
    navigate,
    pin,
    lane?.branchRef,
    projectStateKey,
    refreshLanes,
    requestTextInput,
    selectLane,
  ]);

  const unstageAll = () => {
    if (!laneId) return;
    void runAction("unstage all", async () => {
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.unstageAll({ laneId, paths: changes.staged.map((file) => file.path) }, pin);
    });
  };

  // Two lanes on one branch across two machines are just two lanes — ADE does
  // not arbitrate them. Pushing is the one moment where that can cost work, so
  // it is the one moment that interrupts. Resolved at click time (not in a
  // memo) so a single-machine project pays nothing.
  const resolvePushDivergence = useCallback((): NonNullable<DivergenceWarning> | null => {
    if (!lane) return null;
    // When pinned, "current" is the chat's machine, not the tab's binding —
    // otherwise the guard warns that a machine diverged from itself.
    const guardBinding = pin ?? projectBinding;
    const activeMachineId = currentMachineId
      ?? (guardBinding?.kind === "remote" ? guardBinding.targetId : THIS_MACHINE_GUARD_ID);
    const activeMachineName = currentMachineName ?? machineNameForBinding(guardBinding);
    // The union slice keeps a stable reference while unchanged, so subscribing
    // costs one identity check per store tick and re-renders nothing. The
    // selector itself is memoized and only runs here, at click time. An
    // explicit prop still wins so callers can supply their own set.
    const others = otherMachineBranchStates.length > 0
      ? otherMachineBranchStates
      : selectOtherMachineBranchStates({
          lanes,
          crossMachineLanesByMachineId,
          projectBinding,
        }, lane.id);
    if (others.length === 0) return null;
    return detectPushDivergence({
      current: {
        machineId: activeMachineId,
        machineName: activeMachineName,
        branchRef: lane.branchRef,
        headSha: currentMachineHeadSha,
        ahead: syncStatus?.ahead ?? lane.status.ahead,
        behind: syncStatus?.behind ?? lane.status.behind,
      },
      others,
    });
  }, [
    currentMachineHeadSha,
    currentMachineId,
    currentMachineName,
    crossMachineLanesByMachineId,
    lane,
    lanes,
    otherMachineBranchStates,
    pin,
    projectBinding,
    syncStatus,
  ]);

  const executePush = (forceWithLease: boolean) => {
    if (!laneId) return;
    void runAction(forceWithLease ? "force push" : "push", async () => {
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.push({ laneId, forceWithLease }, pin);
    });
  };

  const runPush = (forceWithLease: boolean) => {
    if (!laneId) return;
    const warning = resolvePushDivergence();
    if (warning) {
      setPendingPush({ kind: "push", forceWithLease, warning });
      return;
    }
    executePush(forceWithLease);
  };

  const runPull = (mode: GitSyncMode) => {
    if (!laneId) return;
    void runAction("pull", async () => {
      const latestConflictState = await window.ade.git.getConflictState(laneId, pin).catch(() => null);
      if (latestConflictState?.inProgress) {
        setConflictState(latestConflictState);
        setStuckRebase(latestConflictState.kind === "rebase" ? latestConflictState : null);
        const kindLabel = latestConflictState.kind === "merge" ? "merge" : "rebase";
        throw new Error(`Finish the current ${kindLabel} before pulling remote changes.`);
      }
      const latestSyncStatus = await window.ade.git.getSyncStatus({ laneId }, pin).catch(() => null);
      if (latestSyncStatus) setSyncStatus(latestSyncStatus);
      const targetBaseRef = latestSyncStatus?.hasUpstream && latestSyncStatus.upstreamRef
        ? latestSyncStatus.upstreamRef
        : (lane?.baseRef ?? undefined);
      invalidateLaneGitCaches(projectStateKey, laneId);
      await window.ade.git.sync({ laneId, mode, baseRef: targetBaseRef }, pin);
    });
  };

  const runFetchOnly = () => {
    if (!laneId) return;
    void runAction("fetch", async () => {
      await window.ade.git.fetch({ laneId }, pin);
    });
  };

  const executeRebaseAndPushFlow = (confirmPublish: boolean) => {
    if (!laneId) return;
    void runAction("rebase and push", async () => {
      if (onRebaseAndPush) {
        await onRebaseAndPush(laneId);
        return;
      }

      invalidateLaneGitCaches(projectStateKey, laneId);
      const start = await window.ade.lanes.rebaseStart({
        laneId,
        pushMode: "none",
        actor: "user"
      }, pin);
      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
        throw new Error(start.run.error ?? "Rebase failed.");
      }

      await window.ade.git.fetch({ laneId }, pin).catch(() => {});
      const latestSyncStatus = await window.ade.git.getSyncStatus({ laneId }, pin);
      setSyncStatus(latestSyncStatus);

      if (!latestSyncStatus.hasUpstream) {
        const missingRemote = latestSyncStatus.upstreamState === "missing";
        if (confirmPublish) {
          const ok = await confirmDialog(
            missingRemote
              ? {
                title: `The remote branch for lane '${lane?.name ?? laneId}' is missing.`,
                message: `Recreate origin/${lane?.branchRef ?? "current branch"}?`,
                confirmLabel: "Recreate",
              }
              : {
                title: `Publish lane '${lane?.name ?? laneId}' to origin/${lane?.branchRef ?? "current branch"}?`,
                confirmLabel: "Publish",
              },
          );
          if (!ok) throw new Error("__ade_cancelled__");
        }
        invalidateLaneGitCaches(projectStateKey, laneId);
        await window.ade.git.push({ laneId }, pin);
        return;
      }

      if (latestSyncStatus.diverged && latestSyncStatus.ahead > 0) {
        if (confirmPublish) {
          const ok = await confirmDialog({
            title: `Lane '${lane?.name ?? laneId}' diverged from remote (${latestSyncStatus.ahead} local ahead, ${latestSyncStatus.behind} remote ahead).`,
            message: "Force push with lease now?",
            confirmLabel: "Force push",
            destructive: true,
          });
          if (!ok) throw new Error("__ade_cancelled__");
        }
        invalidateLaneGitCaches(projectStateKey, laneId);
        await window.ade.git.push({ laneId, forceWithLease: true }, pin);
        return;
      }

      if (latestSyncStatus.ahead > 0) {
        if (confirmPublish) {
          const ok = await confirmDialog({
            title: `Push ${latestSyncStatus.ahead} commit${latestSyncStatus.ahead === 1 ? "" : "s"} for lane '${lane?.name ?? laneId}' now?`,
            confirmLabel: "Push",
          });
          if (!ok) throw new Error("__ade_cancelled__");
        }
        invalidateLaneGitCaches(projectStateKey, laneId);
        await window.ade.git.push({ laneId }, pin);
      }
    });
  };

  const runRebaseAndPushFlow = (confirmPublish = true) => {
    if (!laneId) return;
    const warning = resolvePushDivergence();
    if (warning) {
      setPendingPush({ kind: "rebase-push", confirmPublish, warning });
      return;
    }
    executeRebaseAndPushFlow(confirmPublish);
  };

  // Plain function (not memoized) so the replayed push always closes over the
  // current lane state rather than the state at the moment the dialog opened.
  const confirmPendingPush = () => {
    const pending = pendingPush;
    setPendingPush(null);
    if (!pending) return;
    if (pending.kind === "push") {
      executePush(pending.forceWithLease);
      return;
    }
    executeRebaseAndPushFlow(pending.confirmPublish);
  };

  const cancelPendingPush = useCallback(() => setPendingPush(null), []);

  // A lane switch must never leave another lane's guard on screen.
  useEffect(() => {
    setPendingPush(null);
  }, [laneId]);

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
  }, [conflictState, forcePushSuggested, laneId, syncStatus]);

  const divergedSync = Boolean(syncStatus?.diverged);
  const mergeConflictState = conflictState?.inProgress && conflictState.kind === "merge" ? conflictState : null;
  const pullBlockedByConflict = Boolean(conflictState?.inProgress);
  // The primary lane is the base; it never rebases onto it.
  const canRebaseOntoBase = lane != null && lane.laneType !== "primary";
  const rebaseBase = compareBase?.trim() || (lane ? laneCompareBase(lane) : "");
  const syncButtonDisabled = !laneId || busyAction != null || lane?.status.behind === 0 || lane?.status.dirty;

  const renderFileRow = (file: FileChange, mode: LaneDiffMode) => {
    const rowSelected = selectedPath === file.path && selectedMode === mode;
    if (mode === "branch") {
      // Read-only: staging and discarding belong to the uncommitted changes.
      return (
        <div
          key={`branch:${file.path}`}
          className="flex items-center gap-2 cursor-pointer transition-all duration-150"
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
            onSelectFile(file.path, "branch");
          }}
          onMouseEnter={(event) => {
            if (!rowSelected) event.currentTarget.style.background = COLORS.hoverBg;
          }}
          onMouseLeave={(event) => {
            if (!rowSelected) event.currentTarget.style.background = "transparent";
          }}
        >
          <span className="shrink-0" title={`${file.kind} file`} style={{ width: 7, height: 7, borderRadius: "50%", background: getFileKindColor(file.kind) }} />
          <span className="truncate flex-1" style={{ fontSize: 11 }} title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}>
            {file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
          </span>
          {file.additions != null && file.additions > 0 ? <span style={{ fontSize: 10, color: COLORS.success }}>+{file.additions}</span> : null}
          {file.deletions != null && file.deletions > 0 ? <span style={{ fontSize: 10, color: COLORS.danger }}>-{file.deletions}</span> : null}
          {file.isBinary ? <span className="kit-tag">Binary</span> : null}
        </div>
      );
    }
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
          <span className="kit-tag">Binary</span>
        ) : null}
        {(alsoStaged || alsoUnstaged) ? (
          <span className="kit-tag" data-tone="warn" title="This file has both staged and unstaged changes.">
            Partial
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

  const renderChangeListRow = (row: ChangeListRow): React.ReactNode => {
    if (row.kind === "section") {
      return <div className="ade-git-subgroup">{`${row.label} (${row.count})`}</div>;
    }
    if (row.kind === "notice") {
      return <TruncatedChangesNotice total={row.total} noun={row.noun} onShowAll={() => showAllSection(row.section)} />;
    }
    if (row.kind === "file") {
      return (
        <div style={{ paddingLeft: row.depth * 14 }}>
          {renderFileRow(row.file, row.mode)}
        </div>
      );
    }
    const { key, collapsed, stats } = row;
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        style={{
          padding: "5px 8px",
          paddingLeft: 8 + row.depth * 14,
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
        <span className="truncate" style={{ flex: 1 }}>{row.name}</span>
        <span style={{ color: COLORS.textDim }}>{stats.files}</span>
        {stats.additions > 0 ? <span style={{ color: COLORS.success }}>+{stats.additions}</span> : null}
        {stats.deletions > 0 ? <span style={{ color: COLORS.danger }}>-{stats.deletions}</span> : null}
      </button>
    );
  };

  const diffViewActive = Boolean(
    (selectedPath && selectedMode) || selectedCommit,
  );

  const isNarrow = responsiveMode === "narrow";
  // The base the committed list is measured against, named as the lane names it.
  const committedBase = rebaseBase || branchChanges?.baseRef || "base";
  const committedFileCount = branchChanges?.files.length ?? 0;
  const commitDisabled = (!hasStaged && !amendCommit) || busyAction != null;
  const diffDetail = selectedCommit
    ? `${selectedCommit.shortSha ?? (selectedCommit.sha ?? "").slice(0, 7)} · ${selectedCommit.subject.trim().slice(0, 120)}`
    : `${selectedMode === "staged" ? "Staged" : selectedMode === "branch" ? "Committed" : "Unstaged"} · ${selectedPath ?? ""}`;

  /* Saved stashes, opened from the chrome row's "More git actions". */
  const stashSection = showStashes ? (
    <section className="ade-git-section" data-section="stashes" aria-label="Branch stashes">
      <header className="ade-git-section-head">
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Branch stashes</span>
        <span className="ade-git-count">{stashes.length === 0 ? "None saved" : `${stashes.length} saved`}</span>
        <div className="ade-git-section-aside">
          {stashes.length > 0 ? (
            <SmartTooltip content={{
              label: "Clear Branch Stashes",
              description: "Permanently delete this branch's visible stash entries. You'll be asked to confirm by typing the count.",
              gitCommand: "git stash drop <branch stash refs>",
              effect: `Delete ${stashes.length} branch stash${stashes.length === 1 ? "" : "es"}`,
              warning: "This cannot be undone",
            }}>
              <button
                type="button"
                className="kit-btn kit-btn-ghost"
                data-size="sm"
                data-tone="crit"
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
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.stashClear({ laneId }, pin);
                    await refreshGitMeta(laneId);
                  });
                }}
              >
                Clear stashes
              </button>
            </SmartTooltip>
          ) : null}
          <SmartTooltip content={{
            label: "Save Changes",
            description: "Save this branch's current staged and unstaged changes to a stash without committing. You can restore them later.",
            gitCommand: hasUntrackedChanges ? "git stash push -u" : "git stash push",
            effect: hasUncommittedChanges
              ? `Stash ${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}${hasUntrackedChanges ? ", including untracked files" : ""}`
              : "No changes to save",
          }}>
            <button
              type="button"
              className="kit-btn kit-btn-ghost"
              data-size="sm"
              disabled={!laneId || busyAction != null || !hasUncommittedChanges}
              onClick={() => {
                if (!laneId) return;
                void runAction("stash push", async () => {
                  const msg = await requestTextInput({
                    title: "Stash message",
                    placeholder: "Optional note",
                    confirmLabel: "Save stash",
                  });
                  if (msg == null) throw new Error("__ade_cancelled__");
                  invalidateLaneGitCaches(projectStateKey, laneId);
                  await window.ade.git.stashPush({ laneId, message: msg || undefined, includeUntracked: hasUntrackedChanges }, pin);
                });
              }}
            >
              Save changes
            </button>
          </SmartTooltip>
          <WorkToolChromeButton label="Hide stashes" onClick={() => setShowStashes(false)} testId="git-pane-stashes-close">
            <X size={14} />
          </WorkToolChromeButton>
        </div>
      </header>
      {stashes.length > 0 ? (
        <div className="ade-git-stash-list">
          {stashes.slice(0, maxVisibleStashes).map((stash) => (
            <div key={stash.ref} className="ade-git-stash-row">
              <div className="ade-git-stash-text">
                <div className="ade-git-stash-subject truncate">{stash.subject || stash.ref}</div>
                <div className="ade-git-stash-meta kit-num truncate">
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
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  disabled={!laneId || busyAction != null}
                  onClick={() => {
                    if (!laneId) return;
                    void runAction("stash pop", async () => {
                      invalidateLaneGitCaches(projectStateKey, laneId);
                      await window.ade.git.stashPop({ laneId, stashRef: stash.ref, stashOid: stash.oid }, pin);
                      await refreshGitMeta(laneId);
                    });
                  }}
                >
                  Restore
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
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  disabled={!laneId || busyAction != null}
                  onClick={() => {
                    if (!laneId) return;
                    void runAction("stash apply", async () => {
                      invalidateLaneGitCaches(projectStateKey, laneId);
                      await window.ade.git.stashApply({ laneId, stashRef: stash.ref, stashOid: stash.oid }, pin);
                    });
                  }}
                >
                  Copy to worktree
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
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  data-tone="crit"
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
                      invalidateLaneGitCaches(projectStateKey, laneId);
                      await window.ade.git.stashDrop({ laneId, stashRef: stash.ref, stashOid: stash.oid }, pin);
                      await refreshGitMeta(laneId);
                    });
                  }}
                >
                  Delete
                </button>
              </SmartTooltip>
            </div>
          ))}
          {stashes.length > maxVisibleStashes ? (
            <div className="ade-git-stash-more">
              +{stashes.length - maxVisibleStashes} more stash entr{stashes.length - maxVisibleStashes === 1 ? "y" : "ies"}.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  ) : null;

  /* Work not committed yet: staged and unstaged files, then the commit box. */
  const uncommittedSection = (
    <section className="ade-git-section" data-section="uncommitted" aria-label="Uncommitted changes">
      <header className="ade-git-section-head">
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Uncommitted changes</span>
        {changedFileCount > 0 ? <span className="ade-git-count kit-num">{changedFileCount}</span> : null}
        {hasUncommittedChanges ? (
          <div className="ade-git-section-aside">
            {hasUnstaged ? (
              <SmartTooltip content={{
                label: "Stage All",
                description: "Move all unstaged changes to the staging area so they will be included in the next commit.",
                gitCommand: "git add .",
                effect: `Stage ${changes.unstaged.length} file${changes.unstaged.length === 1 ? "" : "s"}`,
              }}>
                <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={stageAll} disabled={busyAction != null}>
                  Stage all
                </button>
              </SmartTooltip>
            ) : (
              <SmartTooltip content={{
                label: "Unstage All",
                description: "Remove all files from the staging area. Changes are kept but won't be included in the next commit.",
                gitCommand: "git reset HEAD",
                effect: `Unstage ${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"}`,
              }}>
                <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={unstageAll} disabled={busyAction != null}>
                  Unstage all
                </button>
              </SmartTooltip>
            )}
            <span ref={uncommittedMenuTriggerRef} className="inline-flex">
              <WorkToolChromeButton
                label="More for uncommitted changes"
                onClick={() => setShowUncommittedMenu((prev) => !prev)}
                active={showUncommittedMenu}
                testId="git-pane-uncommitted-more"
              >
                <DotsThree size={16} weight="bold" />
              </WorkToolChromeButton>
            </span>
          </div>
        ) : null}
      </header>
      <AnchoredMenu
        open={showUncommittedMenu && hasUncommittedChanges}
        anchorRef={uncommittedMenuTriggerRef}
        onClose={() => setShowUncommittedMenu(false)}
        placement="bottom-end"
        offset={2}
        zIndex={Z_LAYERS.popover}
        role="menu"
        aria-label="More for uncommitted changes"
        className="ade-liquid-glass-menu"
        data-testid="git-pane-uncommitted-menu"
        style={{
          minWidth: 220,
          padding: 4,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 10,
        }}
        // A picked row runs its action; the menu closes behind it.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("[role=\"menuitem\"]")) setShowUncommittedMenu(false);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          {hasUnstaged && hasStaged ? (
            <ActionButton
              title="Unstage all"
              icon={<Minus size={14} />}
              detail="Keep the changes but leave them out of the next commit."
              disabled={busyAction != null}
              onClick={unstageAll}
              smartTooltip={{
                label: "Unstage All",
                description: "Remove all files from the staging area. Changes are kept but won't be included in the next commit.",
                gitCommand: "git reset HEAD",
                effect: `Unstage ${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"}`,
              }}
            />
          ) : null}
          {hasUnstaged ? (
            <ActionButton
              title="Discard unstaged changes"
              icon={<Trash size={14} />}
              tone="danger"
              detail="Revert every unstaged file to its last committed state."
              disabled={busyAction != null}
              onClick={() => { void discardAll(); }}
              smartTooltip={{
                label: "Discard All Unstaged",
                description: "Permanently discard all unstaged changes. Files revert to their last committed state.",
                gitCommand: "git checkout -- .",
                effect: `Discard changes in ${changes.unstaged.length} file${changes.unstaged.length === 1 ? "" : "s"}`,
                warning: "This cannot be undone",
              }}
            />
          ) : null}
          {hasStaged ? (
            <ActionButton
              title="Discard staged changes"
              icon={<Trash size={14} />}
              tone="danger"
              detail="Revert every staged file, and any unstaged edits to it, to its last committed state."
              disabled={busyAction != null}
              onClick={() => { void discardAllStaged(); }}
              smartTooltip={{
                label: "Discard All Staged",
                description: "Permanently discard all staged changes. If any staged file also has unstaged edits, those edits are discarded too.",
                gitCommand: "git restore --staged --worktree --source=HEAD -- <paths>",
                effect: `Discard staged changes in ${changes.staged.length} file${changes.staged.length === 1 ? "" : "s"}`,
                warning: "This cannot be undone",
              }}
            />
          ) : null}
          <div style={{ height: 1, background: COLORS.border, margin: "4px 6px" }} />
          <ActionButton
            title="New lane with these changes"
            icon={<GitBranch size={14} />}
            detail={rescueButtonTitle}
            disabled={rescueButtonDisabled}
            onClick={() => { void newLaneWithChanges(); }}
            smartTooltip={{
              label: "New lane with these changes",
              description: rescueButtonTitle,
              effect: rescueButtonDisabled
                ? "Unavailable"
                : `Copies ${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"} to a new lane`,
            }}
          />
        </div>
      </AnchoredMenu>
      {hasUncommittedChanges ? (
        <ChangeList rows={uncommittedRows} renderRow={renderChangeListRow} testId="git-pane-uncommitted" />
      ) : (
        <div className="ade-git-empty" data-tone="ok" data-testid="git-pane-clean">
          <CheckCircle size={14} aria-hidden />
          No uncommitted changes
        </div>
      )}
      <div className="ade-git-composer">
        <input
          disabled={busyAction != null}
          data-testid="git-pane-commit-message"
          className="kit-input"
          aria-label="Commit message"
          placeholder={amendCommit ? "New message for the last commit" : "Commit message"}
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submitCommit();
            }
          }}
        />
        <WorkToolChromeButton
          label={amendCommit ? "Amend is on" : "Amend last commit"}
          onClick={() => setAmendCommit((prev) => !prev)}
          active={amendCommit}
          disabled={busyAction != null}
          testId="git-pane-amend"
        >
          <ArrowUUpLeft size={16} />
        </WorkToolChromeButton>
        <button
          type="button"
          className="kit-btn kit-btn-primary"
          data-testid="git-pane-commit-inline"
          title={(!hasStaged && !amendCommit) ? "Stage a file to commit" : `${amendCommit ? "Amend" : "Commit"} (${modifierKeyLabel}+Enter)`}
          onClick={() => { void submitCommit(); }}
          disabled={commitDisabled}
        >
          {amendCommit ? "Amend" : "Commit"}
        </button>
      </div>
    </section>
  );

  /*
    Read-only: the files this lane's commits changed since it left its base.
    Hidden on a host that predates branch diffs.
  */
  const committedSection = branchSupported ? (
    <section className="ade-git-section" data-section="committed" aria-label="Committed on this branch">
      <header className="ade-git-section-head">
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Committed on this branch</span>
        {committedFileCount > 0 ? <span className="ade-git-count kit-num">{committedFileCount}</span> : null}
        <span
          className="ade-git-base kit-num"
          title={branchChanges ? `Since ${branchChanges.mergeBase.slice(0, 9)}, where this lane left ${branchChanges.baseRef}` : undefined}
        >
          vs {committedBase}
          {!isNarrow && branchChanges && committedFileCount > 0 ? (
            <>
              {" · "}
              <span style={{ color: COLORS.success }}>+{branchChanges.additions}</span>{" "}
              <span style={{ color: COLORS.danger }}>-{branchChanges.deletions}</span>
            </>
          ) : null}
        </span>
      </header>
      {branchError ? (
        <Banner
          layout="inline"
          style={{ margin: "4px 0" }}
          model={{
            id: "git-pane-branch-changes-error",
            tone: "error",
            title: branchError,
            report: { surface: "git_pane_branch_changes" },
          }}
        />
      ) : !branchChanges ? (
        <div className="ade-git-empty">Reading commits…</div>
      ) : committedFileCount === 0 ? (
        <div className="ade-git-empty" data-testid="git-pane-committed-empty">
          <GitCommit size={14} aria-hidden />
          Nothing committed yet beyond {committedBase}
        </div>
      ) : (
        <ChangeList rows={committedRows} renderRow={renderChangeListRow} testId="git-pane-branch" />
      )}
    </section>
  ) : null;

  /* A picked file or commit: its diff takes the place of the two lists. */
  const diffSection = (
    <section className="ade-git-section" data-section="diff" aria-label="Diff">
      <header className="ade-git-section-head">
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Diff</span>
        <span className="ade-git-section-detail" title={diffDetail}>{diffDetail}</span>
        <button
          type="button"
          className="kit-btn kit-btn-ghost"
          data-size="sm"
          title="Back to the changed files"
          disabled={!onClearDiffSelection}
          onClick={() => onClearDiffSelection?.()}
        >
          <ArrowLeft size={12} weight="bold" />
          Changes
        </button>
      </header>
      <div className="ade-git-diff-frame">
        <LaneDiffPane
          laneId={laneId}
          runtimePin={pin}
          selectedPath={selectedPath}
          selectedFileMode={selectedMode}
          selectedCommit={selectedCommit}
          liveSync
        />
      </div>
    </section>
  );

  const historySection = (
    <section className="ade-git-section" data-section="history" data-testid="history-section" aria-label="History">
      <header className="ade-git-section-head">
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>History</span>
      </header>
      <div className="ade-git-history">
        {/* Keyed by lane, pin and branch: a switch remounts it, so it opens on that lane's cached rows, never the previous lane's. */}
        <CommitTimeline
          key={`${listScope ?? ""}\u0000${listBranchRef ?? ""}`}
          laneId={laneId ?? null}
          runtimePin={pin}
          cacheScope={listScope}
          cacheBranchRef={listBranchRef}
          active={active}
          selectedSha={selectedCommitSha}
          refreshTrigger={commitTimelineKey}
          hasUpstream={syncStatus?.hasUpstream ?? null}
          remoteMissing={upstreamMissing}
          onSelectCommit={(commit) => {
            onSelectCommit(commit);
          }}
        />
      </div>
    </section>
  );

  /*
    The pane's one chrome row: which branch, how far from the remote, and
    the things you do about it, as a ghost chip, a muted count and 28px glyphs.
  */
  const paneAhead = syncStatus?.hasUpstream ? syncStatus.ahead : lane?.status.ahead ?? 0;
  const paneBehind = syncStatus?.hasUpstream ? syncStatus.behind : lane?.status.behind ?? 0;
  const paneChromeRow = (
    <div className={WORK_TOOL_CHROME_ROW} data-testid="git-pane-chrome">
      <PaneTooltip label={lane?.branchRef ?? "No branch"} side="bottom" className={WORK_TOOL_CHROME_CHIP_WRAP}>
        <span className={cn(WORK_TOOL_CHROME_CHIP, "cursor-default font-mono")}>
          <BranchIcon size={12} weight="bold" aria-hidden className="shrink-0 text-muted-fg" />
          <span className="min-w-0 truncate">{lane?.branchRef ? lane.branchRef.replace(/^refs\/heads\//, "") : "No branch"}</span>
        </span>
      </PaneTooltip>
      {paneAhead > 0 || paneBehind > 0 ? (
        <PaneTooltip
          label={`${paneAhead} ahead, ${paneBehind} behind ${syncStatus?.hasUpstream ? "remote" : "base"}`}
          side="bottom"
        >
          <span className={WORK_TOOL_CHROME_META} data-testid="git-pane-divergence">
            {paneAhead}↑ {paneBehind}↓
          </span>
        </PaneTooltip>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <WorkToolChromeButton
          label={amendCommit ? "Amend commit" : "Commit"}
          shortcut={`${modifierKeyLabel}+Enter`}
          onClick={() => { void submitCommit(); }}
          disabled={(!hasStaged && !amendCommit) || busyAction != null}
          testId="git-pane-commit"
        >
          <GitCommit size={16} />
        </WorkToolChromeButton>
        <WorkToolChromeButton
          label={`Pull (${syncMode})`}
          onClick={() => runPull(syncMode)}
          disabled={!laneId || busyAction != null || pullBlockedByConflict}
          testId="git-pane-pull"
        >
          <ArrowDown size={16} />
        </WorkToolChromeButton>
        <WorkToolChromeButton
          label={upstreamMissing
            ? "Recreate remote branch"
            : syncStatus?.hasUpstream === false
              ? "Publish branch"
              : nextActionHint?.action === "force_push_lease"
                ? "Force push (lease)"
                : "Push"}
          onClick={async () => {
            if (nextActionHint?.action === "force_push_lease") {
              const ok = await confirmForcePushWithLease();
              if (!ok) return;
              runPush(true);
              return;
            }
            runPush(false);
          }}
          disabled={!laneId || busyAction != null}
          testId="git-pane-push"
        >
          <ArrowUp size={16} />
        </WorkToolChromeButton>
        {canRebaseOntoBase ? (
          <WorkToolChromeButton
            label={`Rebase onto ${rebaseBase} and push`}
            onClick={() => runRebaseAndPushFlow(true)}
            disabled={syncButtonDisabled}
            testId="git-pane-rebase"
          >
            <Stack size={16} />
          </WorkToolChromeButton>
        ) : null}
        <span ref={advancedTriggerRef} className="inline-flex">
          <WorkToolChromeButton
            label="More git actions"
            onClick={() => setShowAdvanced((prev) => !prev)}
            active={showAdvanced}
            testId="git-pane-more"
          >
            <DotsThree size={16} weight="bold" />
          </WorkToolChromeButton>
        </span>
        <WorkToolChromeButton
          label="Refresh"
          onClick={() => {
            setShowAdvanced(false);
            refreshAll({ fetchRemote: true }).catch(() => {});
          }}
          testId="git-pane-refresh"
        >
          <ArrowsClockwise size={16} className={cn(loading && "animate-spin")} />
        </WorkToolChromeButton>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
      <div className="relative shrink-0">
        {paneChromeRow}
        {/* ─── Advanced Git (collapsible) ─── */}
          {/* A dropdown: Escape or a press outside it (or its trigger) closes it. */}
          <AnchoredMenu
            open={showAdvanced}
            anchorRef={advancedTriggerRef}
            onClose={() => setShowAdvanced(false)}
            placement="bottom-end"
            offset={2}
            zIndex={Z_LAYERS.popover}
            role="menu"
            aria-label="More git actions"
            className="ade-liquid-glass-menu"
            data-testid="advanced-section"
            style={{
              minWidth: 220,
              padding: 4,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 10,
            }}
            // A picked row runs its action; the menu closes behind it.
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("[role=\"menuitem\"]")) setShowAdvanced(false);
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <ActionButton
                title="Fetch only"
                icon={<ArrowDown size={14} />}
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
                icon={<ArrowUp size={14} weight="bold" />}
                tone="caution"
                detail="Overwrite the remote branch only if nobody else pushed in the meantime."
                badge={nextActionHint?.action === "force_push_lease" || divergedSync ? "Check first" : null}
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
              {canRebaseOntoBase ? (
                <ActionButton
                  title={`Rebase onto ${rebaseBase}`}
                  icon={<Stack size={14} />}
                  detail={lane?.status.behind === 0
                    ? `Already up to date with ${rebaseBase}.`
                    : lane?.status.dirty
                      ? "Commit or stash uncommitted changes before rebasing."
                      : `Replay this lane's commits on top of ${rebaseBase} without pushing anything yet.`}
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
                      invalidateLaneGitCaches(projectStateKey, laneId);
                      const start = await window.ade.lanes.rebaseStart({
                        laneId,
                        pushMode: "none",
                        actor: "user"
                      }, pin);
                      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
                        throw new Error(start.run.error ?? "Rebase failed.");
                      }
                    });
                  }}
                  smartTooltip={{
                    label: `Rebase onto ${rebaseBase}`,
                    description: `Replay your commits on top of ${rebaseBase} without pushing. Use this to stay current before pushing.`,
                    gitCommand: `git rebase ${rebaseBase}`,
                    effect: lane?.status.behind === 0
                      ? `Already up to date with ${rebaseBase}`
                      : lane?.status.dirty
                        ? "Cannot rebase: uncommitted changes present"
                        : `${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"} behind ${rebaseBase}`,
                    warning: lane?.status.dirty ? "Commit or stash changes first" : undefined,
                  }}
                />
              ) : null}
              {canRebaseOntoBase ? (
                <ActionButton
                  title="View rebase details"
                  icon={<GitBranch size={14} />}
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
                icon={<ArrowUUpLeft size={14} />}
                detail="Create a new commit that undoes an earlier commit."
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (!laneId) return;
                  void runAction("revert commit", async () => {
                    const commits = await window.ade.git.listRecentCommits({ laneId, limit: 20 }, pin);
                    const sha = await requestTextInput({
                      title: "Commit SHA to revert",
                      defaultValue: commits[0]?.sha ?? "",
                      validate: (value) => (value ? null : "Commit SHA is required")
                    });
                    if (!sha) throw new Error("__ade_cancelled__");
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.revertCommit({ laneId, commitSha: sha }, pin);
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
                icon={<GitCommit size={14} />}
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
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.cherryPickCommit({ laneId, commitSha: sha }, pin);
                  });
                }}
                smartTooltip={{
                  label: "Cherry-pick",
                  description: "Copy a commit from another branch and apply it on top of this lane. Creates a new commit with the same changes.",
                  gitCommand: "git cherry-pick <sha>",
                  effect: "You'll be prompted for a commit SHA to cherry-pick",
                }}
              />
              <div style={{ height: 1, background: COLORS.border, margin: "4px 6px" }} />
              <ActionButton
                title={stashes.length > 0 ? `Branch stashes (${stashes.length})` : "Branch stashes"}
                icon={<Archive size={14} />}
                detail="Save changes without committing, or restore them."
                disabled={!laneId}
                onClick={() => {
                  setShowAdvanced(false);
                  setShowStashes((prev) => !prev);
                }}
              />
            </div>
          </AnchoredMenu>

      </div>

      {stuckRebase ? (
        <Banner
          layout="inline"
          style={{ margin: "6px 8px", flexShrink: 0 }}
          model={{
            id: `lane-stuck-rebase:${laneId ?? ""}`,
            tone: "error",
            title: "Rebase in progress",
            detail: stuckRebase.conflictedFiles.length > 0
              ? `${stuckRebase.conflictedFiles.length} conflicted file${stuckRebase.conflictedFiles.length === 1 ? "" : "s"}. Commits and pushes are blocked until you resolve them.`
              : "An interrupted rebase is blocking commits and pushes. Abort or continue to unlock the lane.",
            actions: [
              ...(stuckRebase.canAbort ? [{
                label: "Abort rebase",
                title: "Cancel the rebase and return to the state before it started. Command: git rebase --abort. Undo the rebase and restore the previous branch state. Warning: Any resolved conflicts will be lost.",
                variant: "secondary" as const,
                disabled: busyAction != null,
                onClick: () => {
                  if (!laneId) return;
                  void runAction("abort rebase", async () => {
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.rebaseAbort(laneId, pin);
                  });
                },
              }] : []),
              ...(stuckRebase.canContinue ? [{
                label: "Continue rebase",
                title: "Continue the rebase after resolving conflicts. The next commit in the rebase sequence will be applied. Command: git rebase --continue. Apply resolved conflicts and continue rebasing.",
                variant: "solid" as const,
                disabled: busyAction != null,
                onClick: () => {
                  if (!laneId) return;
                  void runAction("continue rebase", async () => {
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.rebaseContinue(laneId, pin);
                  });
                },
              }] : []),
            ],
          }}
        />
      ) : null}

      {mergeConflictState ? (
        <Banner
          layout="inline"
          style={{ margin: "6px 8px", flexShrink: 0 }}
          model={{
            id: `lane-merge-conflict:${laneId ?? ""}`,
            tone: "error",
            title: "Merge in progress",
            detail: mergeConflictState.conflictedFiles.length > 0
              ? `${mergeConflictState.conflictedFiles.length} conflicted file${mergeConflictState.conflictedFiles.length === 1 ? "" : "s"}. Resolve them before continuing or aborting the merge.`
              : "An interrupted merge is blocking pull and push actions. Continue or abort to unlock the lane.",
            actions: [
              ...(mergeConflictState.canAbort ? [{
                label: "Abort merge",
                title: "Cancel the merge and return to the state before it started. Command: git merge --abort. Undo the merge and restore the previous branch state. Warning: Any resolved conflicts will be lost.",
                variant: "secondary" as const,
                disabled: busyAction != null,
                onClick: () => {
                  if (!laneId) return;
                  void runAction("abort merge", async () => {
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.mergeAbort(laneId, pin);
                  });
                },
              }] : []),
              ...(mergeConflictState.canContinue ? [{
                label: "Continue merge",
                title: "Finish the merge after resolving all conflicts. A merge commit will be created. Command: git merge --continue. Create the merge commit with resolved conflicts.",
                variant: "solid" as const,
                disabled: busyAction != null,
                onClick: () => {
                  if (!laneId) return;
                  void runAction("continue merge", async () => {
                    invalidateLaneGitCaches(projectStateKey, laneId);
                    await window.ade.git.mergeContinue(laneId, pin);
                  });
                },
              }] : []),
            ],
          }}
        />
      ) : null}

      <div
        className="ade-git-body"
        data-testid="git-sections"
        data-committed={branchSupported ? undefined : "hidden"}
      >
        {diffViewActive ? diffSection : (
          <>
            {stashSection}
            {uncommittedSection}
            {committedSection}
          </>
        )}
        {historySection}
      </div>

      {(notice || error || busyAction) ? (
        <Banner
          layout="inline"
          style={{ margin: "4px 8px", flexShrink: 0 }}
          model={{
            id: `lane-git-action-status:${laneId ?? ""}`,
            tone: error ? "error" : notice ? "success" : "accent",
            title: error
              ? `ERROR: ${error}`
              : notice
                ? notice.toUpperCase()
                : `RUNNING ${busyAction?.toUpperCase() ?? ""}...`,
            busy: Boolean(busyAction),
          }}
        />
      ) : null}

      <PushDivergenceDialog
        warning={pendingPush?.warning ?? null}
        onCancel={cancelPendingPush}
        onConfirm={confirmPendingPush}
      />
    </div>
  );
}
