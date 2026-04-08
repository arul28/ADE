import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowsClockwise, Check, Stack, Trash, Upload, Warning } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, outlineButton, primaryButton, dangerButton } from "./laneDesignTokens";
import { CommitTimeline } from "./CommitTimeline";
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
  action: GitRecommendedAction | "rebase_push";
  label: string;
  detail: string;
};

type CommitMessageAiState = {
  enabled: boolean;
  modelId: string | null;
};

type ResponsiveMode = "narrow" | "medium" | "wide";

const AUTO_GENERATE_COMMIT_ACTION = "generate commit message";
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
    return "Press Cmd+Enter to commit with the typed message.";
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

function getPushSummary(syncStatus: GitUpstreamSyncStatus | null): string {
  if (syncStatus?.hasUpstream === false) {
    return "Publish lane creates the remote branch and connects this lane to it.";
  }
  return "Push sends your local commits to the tracked remote branch.";
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
  bodyStyle,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  dataTestId?: string;
  showDescription?: boolean;
  sectionStyle?: React.CSSProperties;
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
  disabled,
  style,
  children,
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip: string;
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

  if (!disabled) return button;
  return (
    <span title={tooltip} style={{ display: "inline-flex" }}>
      {button}
    </span>
  );
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
}: {
  title: string;
  detail: string;
  onClick: () => void;
  disabled: boolean;
  emphasis?: "primary" | "secondary";
  badge?: string | null;
  icon?: React.ReactNode;
  fullWidth?: boolean;
}) {
  const primary = emphasis === "primary";
  return (
    <HoverTitleButton
      type="button"
      disabled={disabled}
      onClick={onClick}
      tooltip={`${title}. ${detail}`}
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
        background: primary ? `${COLORS.accent}14` : "transparent",
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
  onOpenSettings,
  onRebaseNowLocal,
  onRebaseAndPush,
  onViewRebaseDetails,
  onResolveRebaseConflict,
  onSelectFile,
  onSelectCommit,
  selectedPath,
  selectedMode,
  selectedCommitSha
}: {
  laneId: string | null;
  autoRebaseEnabled: boolean;
  onOpenSettings: () => void;
  onRebaseNowLocal?: (laneId: string) => Promise<void> | void;
  onRebaseAndPush?: (laneId: string) => Promise<void> | void;
  onViewRebaseDetails?: (laneId?: string | null) => void;
  onResolveRebaseConflict?: (laneId: string, parentLaneId: string | null) => void;
  onSelectFile: (path: string, mode: "staged" | "unstaged") => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  selectedPath: string | null;
  selectedMode: "staged" | "unstaged" | null;
  selectedCommitSha: string | null;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);

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

  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>({ unstaged: [], staged: [] });
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageAi, setCommitMessageAi] = useState<CommitMessageAiState>({ enabled: false, modelId: null });
  const [syncMode, setSyncMode] = useState<GitSyncMode>("merge");
  const [stashes, setStashes] = useState<GitStashSummary[]>([]);
  const [syncStatus, setSyncStatus] = useState<GitUpstreamSyncStatus | null>(null);
  const [forcePushSuggested, setForcePushSuggested] = useState(false);
  const [textPrompt, setTextPrompt] = useState<LaneTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);
  const [commitTimelineKey, setCommitTimelineKey] = useState(0);
  const [amendCommit, setAmendCommit] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoRebaseStatus, setAutoRebaseStatus] = useState<AutoRebaseLaneStatus | null>(null);
  const [conflictState, setConflictState] = useState<GitConflictState | null>(null);
  const [stuckRebase, setStuckRebase] = useState<GitConflictState | null>(null);
  const laneGitActionRuntime = useLaneGitActionRuntimeState(laneId);
  const busyAction = laneGitActionRuntime.busyAction;
  const notice = laneGitActionRuntime.notice;
  const error = laneGitActionRuntime.error;

  const stagedCount = changes.staged.length;
  const hasStaged = stagedCount > 0;
  const hasUnstaged = changes.unstaged.length > 0;
  const responsiveMode = getResponsiveMode(paneWidth);
  const maxVisibleStashes = responsiveMode === "wide" ? 2 : 3;
  const actionGridColumns =
    responsiveMode === "wide" ? "repeat(3, minmax(0, 1fr))" : responsiveMode === "medium" ? "repeat(2, minmax(0, 1fr))" : "1fr";
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
    if (isViewingLane(targetLaneId)) setLoading(true);
    try {
      const next = await window.ade.diff.getChanges({ laneId: targetLaneId });
      if (isViewingLane(targetLaneId)) {
        setChanges(next);
      }
    } finally {
      if (isViewingLane(targetLaneId)) {
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

    if (!isViewingLane(targetLaneId)) return;

    if (stashesResult.status === "fulfilled") setStashes(stashesResult.value);
    if (syncStatusResult.status === "fulfilled") {
      setSyncStatus(syncStatusResult.value);
    } else {
      setSyncStatus(null);
    }
    if (conflictResult.status === "fulfilled") {
      const cs = conflictResult.value;
      setConflictState(cs);
      setStuckRebase(cs.kind === "rebase" && cs.inProgress ? cs : null);
    } else {
      setConflictState(null);
      setStuckRebase(null);
    }
  };

  const refreshAll = async (options?: { fetchRemote?: boolean }, targetLaneId: string | null = laneId) => {
    if (targetLaneId && options?.fetchRemote) {
      try {
        await window.ade.git.fetch({ laneId: targetLaneId });
      } catch {
        // best effort
      }
    }
    await Promise.all([refreshChanges(targetLaneId), refreshLanes(), refreshGitMeta(targetLaneId)]);
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
      if (isViewingLane(targetLaneId)) {
        setAutoRebaseStatus(statuses.find((entry) => entry.laneId === targetLaneId) ?? null);
      }
    } catch {
      if (isViewingLane(targetLaneId)) {
        setAutoRebaseStatus(null);
      }
    }
  }, [isViewingLane, laneId]);

  const refreshCommitMessageAiState = useCallback(async () => {
    try {
      const snapshot = await window.ade.projectConfig.get();
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
  }, []);

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
      if (actionName === "push" && isNonFastForwardError(message) && isViewingLane(actionLaneId)) {
        setForcePushSuggested(true);
      }
      patchLaneGitActionRuntimeStateIfCurrent(actionLaneId, actionVersion, {
        busyAction: null,
        notice: null,
        error: formatActionError(actionName, message),
      });
    }
  };

  const completeCommitRefresh = useCallback(async (targetLaneId: string) => {
    await Promise.all([refreshChanges(targetLaneId), refreshLanes(), refreshGitMeta(targetLaneId)]);
    if (isViewingLane(targetLaneId)) {
      setCommitTimelineKey((prev) => prev + 1);
      setCommitMessage("");
      setAmendCommit(false);
    }
  }, [isViewingLane, refreshChanges, refreshGitMeta, refreshLanes]);

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
    setLoading(false);
    setChanges({ staged: [], unstaged: [] });
    setStashes([]);
    setSyncStatus(null);
    setForcePushSuggested(false);
    setAmendCommit(false);
    setCommitMessageAi({ enabled: false, modelId: null });
    setAutoRebaseStatus(null);
    setConflictState(null);
    setStuckRebase(null);
    if (!laneId) return;
    refreshAll(undefined, laneId).catch((err) => {
      patchLaneGitActionRuntimeState(laneId, {
        notice: null,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    void refreshAutoRebaseStatus(laneId);
    void refreshCommitMessageAiState();
  }, [laneId, lane?.branchRef, refreshAutoRebaseStatus, refreshCommitMessageAiState]);

  useEffect(() => {
    if (!laneId) return;
    let refreshTimer: number | null = null;
    const effectLaneId = laneId;
    const refreshSyncStatus = () => {
      void window.ade.git
        .getSyncStatus({ laneId: effectLaneId })
        .then((nextStatus) => {
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
    scheduleRefreshSyncStatus();
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
  }, [isViewingLane, laneId]);

  useEffect(() => {
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      if (!laneId) {
        setAutoRebaseStatus(null);
        return;
      }
      setAutoRebaseStatus(event.statuses.find((entry) => entry.laneId === laneId) ?? null);
    });
    return unsubscribe;
  }, [laneId]);

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
        if (confirmPublish) {
          const ok = window.confirm(`Publish lane '${lane?.name ?? laneId}' to origin/${lane?.branchRef ?? "current branch"}?`);
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

  const nextActionHint = useMemo<NextActionHint | null>(() => {
    if (!laneId) return null;
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
  }, [forcePushSuggested, lane, laneId, syncStatus]);

  const divergedSync = Boolean(syncStatus?.diverged);
  const behindCount = syncStatus?.behind ?? 0;
  const headerDotColor = getLaneHeaderDotColor(lane);
  const pushButtonTitle = syncStatus?.hasUpstream === false ? "Publish lane" : "Push to remote";
  const rebaseConflictParentLaneId = autoRebaseStatus?.parentLaneId ?? lane?.parentLaneId ?? null;
  const isGeneratingCommitMessage = busyAction === AUTO_GENERATE_COMMIT_ACTION;
  const commitButtonLabel = getCommitButtonLabel({ busyAction, amendCommit });
  const commitHelperText = getCommitHelperText({ commitMessage, commitMessageAi });
  const primaryPushLabel = syncStatus?.hasUpstream === false ? "Publish lane" : "Push to remote";
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
        <button
          type="button"
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
          title={mode === "staged" ? "Remove this file from the next commit." : "Include this file in the next commit."}
        >
          {mode === "staged" ? <Check size={9} style={{ color: COLORS.accent }} /> : null}
        </button>
        <span
          className="shrink-0"
          title={`${file.kind} file`}
          style={{ width: 7, height: 7, borderRadius: "50%", background: kindColor }}
        />
        <span className="truncate flex-1" style={{ fontSize: 11 }}>{file.path}</span>
        {(alsoStaged || alsoUnstaged) ? (
          <span
            title="This file has both staged and unstaged changes."
            style={inlineBadge(COLORS.warning, { fontSize: 9 })}
          >
            PARTIAL
          </span>
        ) : null}
        {mode === "unstaged" ? (
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
            title="Discard changes to this file. This cannot be undone."
          >
            <Trash size={12} />
          </button>
        ) : null}
      </div>
    );
  };

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
          {lane ? (
            <>
              <span
                title={`Git branch: ${lane.branchRef}`}
                style={{
                  padding: "3px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                  color: COLORS.accent,
                  background: `${COLORS.accent}15`,
                  letterSpacing: "0.5px",
                }}
              >
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
                  background: lane.status.dirty ? `${COLORS.warning}15` : "#10B98115",
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
              syncStatus.hasUpstream ? (
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
            background: `${COLORS.danger}12`,
            borderBottom: `1px solid ${COLORS.danger}30`,
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
              ) : null}
              {stuckRebase.canContinue ? (
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
          const search = new URLSearchParams({ tab: "rebase", laneId });
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
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), border: `1px solid ${COLORS.accent}50` }}
                  disabled={!laneId || busyAction != null}
                  onClick={openRebaseTab}
                >
                  OPEN REBASE TAB
                </button>
              ) : (
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), border: `1px solid ${COLORS.accent}50` }}
                  disabled={!laneId || busyAction != null}
                  onClick={() => runRebaseAndPushFlow(true)}
                >
                  REBASE AND PUSH
                </button>
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
            <button
              type="button"
              style={{
                ...outlineButton({ height: 30, padding: "0 8px", fontSize: 10, borderRadius: 6 }),
                color: amendCommit ? COLORS.warning : COLORS.textDim,
                border: `1px solid ${amendCommit ? `${COLORS.warning}40` : COLORS.outlineBorder}`,
                background: amendCommit ? `${COLORS.warning}10` : "transparent",
              }}
              disabled={busyAction != null}
              onClick={() => setAmendCommit((prev) => !prev)}
              title={getAmendSummary(amendCommit)}
            >
              {amendCommit ? "AMEND ON" : "AMEND"}
            </button>
            <button
              type="button"
              style={{
                ...primaryButton({ height: 30, padding: "0 12px", fontSize: 10, borderRadius: 6 }),
                opacity: ((!hasStaged && !amendCommit) || busyAction != null) ? 0.45 : 1,
                pointerEvents: ((!hasStaged && !amendCommit) || busyAction != null) ? "none" : "auto",
              }}
              disabled={(!hasStaged && !amendCommit) || busyAction != null}
              onClick={() => void submitCommit()}
              title={amendCommit ? "Rewrite the latest commit" : "Create a new commit from staged changes"}
            >
              {commitButtonLabel}
            </button>

            {/* Separator */}
            <div style={{ width: 1, height: 20, background: COLORS.border, margin: "0 2px", flexShrink: 0 }} />

            {/* Sync controls */}
            <div className="flex items-center" style={{ gap: 2 }}>
              {(["merge", "rebase"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={!laneId || busyAction != null}
                  onClick={() => setSyncMode(mode)}
                  style={{
                    ...outlineButton({ height: 26, padding: "0 6px", fontSize: 9, borderRadius: 4 }),
                    color: syncMode === mode ? COLORS.accent : COLORS.textDim,
                    border: `1px solid ${syncMode === mode ? `${COLORS.accent}40` : "transparent"}`,
                    background: syncMode === mode ? `${COLORS.accent}10` : "transparent",
                    opacity: !laneId || busyAction != null ? 0.5 : 1,
                  }}
                  title={getPullModeSummary(mode)}
                >
                  {mode === "merge" ? "MERGE" : "REBASE"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={behindCount > 0 ? "pull-btn-flash" : undefined}
              style={{
                ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                ...(nextActionHint?.action === "pull" ? { color: COLORS.accent, border: `1px solid ${COLORS.accent}40`, background: `${COLORS.accent}08` } : {}),
              }}
              disabled={!laneId || busyAction != null}
              onClick={() => runPull(syncMode)}
              title={`Pull (${syncMode}). ${getPullModeSummary(syncMode)}`}
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
            <button
              type="button"
              style={{
                ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                ...(nextActionHint?.action === "push" || nextActionHint?.action === "force_push_lease" ? { color: COLORS.accent, border: `1px solid ${COLORS.accent}40`, background: `${COLORS.accent}08` } : {}),
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
              title={nextActionHint?.action === "force_push_lease" ? "Force push (lease) — history was rewritten" : getPushSummary(syncStatus)}
            >
              <Upload size={12} weight="bold" style={{ marginRight: 4 }} />
              {syncStatus?.hasUpstream === false ? "PUBLISH" : nextActionHint?.action === "force_push_lease" ? "FORCE PUSH" : "PUSH"}
            </button>
            {lane?.parentLaneId ? (
              <HoverTitleButton
                type="button"
                style={{
                  ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                  ...(nextActionHint?.action === "rebase_push" ? { color: COLORS.accent, border: `1px solid ${COLORS.accent}40`, background: `${COLORS.accent}08` } : {}),
                  opacity: syncButtonDisabled ? 0.45 : 1,
                }}
                disabled={syncButtonDisabled}
                onClick={() => runRebaseAndPushFlow(true)}
                tooltip={syncButtonTitle}
              >
                <Stack size={12} weight="bold" style={{ marginRight: 4 }} />
                SYNC
              </HoverTitleButton>
            ) : null}

            {/* Separator */}
            <div style={{ width: 1, height: 20, background: COLORS.border, margin: "0 2px", flexShrink: 0 }} />

            {/* Advanced toggle */}
            <button
              type="button"
              style={{
                ...outlineButton({ height: 30, padding: "0 10px", fontSize: 10, borderRadius: 6 }),
                color: showAdvanced ? COLORS.accent : COLORS.textMuted,
                border: `1px solid ${showAdvanced ? `${COLORS.accent}30` : COLORS.outlineBorder}`,
              }}
              onClick={() => setShowAdvanced((prev) => !prev)}
              title="Advanced git operations"
            >
              MORE {showAdvanced ? "\u25B4" : "\u25BE"}
            </button>

            {/* Refresh */}
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
              title="Refresh git state"
            >
              <ArrowsClockwise size={13} className={cn(loading && "animate-spin")} />
            </button>
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
              />
              <ActionButton
                title="Force push (lease)"
                detail="Overwrite the remote branch only if nobody else pushed in the meantime."
                badge={nextActionHint?.action === "force_push_lease" || divergedSync ? "CHECK FIRST" : null}
                disabled={!laneId || busyAction != null}
                onClick={() => runPush(true)}
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
                />
              ) : null}
              {lane?.parentLaneId ? (
                <ActionButton
                  title="View rebase details"
                  detail="See detailed rebase history, including conflicts and timing."
                  disabled={!laneId || busyAction != null}
                  onClick={() => onViewRebaseDetails?.(laneId)}
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
                  background: `${COLORS.info}08`,
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
            title="Files"
            description="Changed files and stash controls."
            dataTestId="files-section"
            sectionStyle={{ minHeight: 0, height: "100%" }}
            bodyStyle={{ flex: 1, minHeight: 0 }}
            aside={
              <div className="flex flex-wrap items-center gap-2">
                <span title={`${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}`} style={inlineBadge(COLORS.accent, { fontSize: 9 })}>
                  {changedFileCount}
                </span>
                {changes.unstaged.length > 0 ? (
                  <>
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      onClick={stageAll}
                      disabled={busyAction != null}
                      title={busyAction != null ? "Action in progress" : "Stage all unstaged changes"}
                    >
                      STAGE ALL
                    </button>
                    <button
                      type="button"
                      style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      onClick={discardAll}
                      disabled={busyAction != null}
                      title="Discard all unstaged changes. This cannot be undone."
                    >
                      DISCARD ALL
                    </button>
                  </>
                ) : null}
                {changes.staged.length > 0 ? (
                  <button
                    type="button"
                    style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                    onClick={unstageAll}
                  >
                    UNSTAGE ALL
                  </button>
                ) : null}
                {showRescueButton ? (
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
                ) : null}
              </div>
            }
          >
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
                  <span style={LABEL_STYLE}>STASHES</span>
                  <span style={{ fontSize: 10, color: COLORS.textDim }}>
                    {stashes.length === 0 ? "None saved" : `${stashes.length} saved`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {stashes.length > 0 && (
                    <button
                      type="button"
                      style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={!laneId || busyAction != null}
                      title="Permanently delete all stash entries"
                      onClick={() => {
                        if (!laneId) return;
                        void runAction("stash clear", async () => {
                          const confirmation = await requestTextInput({
                            title: "Clear all stashes?",
                            message: `This will permanently delete ${stashes.length} stash${stashes.length === 1 ? "" : "es"}. Type "${stashes.length}" to confirm.`,
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
                      CLEAR ALL
                    </button>
                  )}
                  <button
                    type="button"
                    style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                    disabled={!laneId || busyAction != null || (!hasStaged && !hasUnstaged)}
                    title={!hasStaged && !hasUnstaged ? "No changes to save" : "Save current changes without committing"}
                    onClick={() => {
                      if (!laneId) return;
                      void runAction("stash push", async () => {
                        const msg = await requestTextInput({
                          title: "Stash message",
                          placeholder: "Optional note",
                          confirmLabel: "Save stash",
                        });
                        if (msg == null) throw new Error("__ade_cancelled__");
                        await window.ade.git.stashPush({ laneId, message: msg || undefined });
                      });
                    }}
                  >
                    SAVE CHANGES
                  </button>
                </div>
              </div>
              {stashes.length === 0 ? (
                <div style={{ fontSize: 10, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  Save your in-progress changes without committing. You can restore them later.
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
                        <button
                          type="button"
                          style={{ ...outlineButton({ height: 24, padding: "0 8px", fontSize: 10 }), border: `1px solid ${COLORS.accent}50` }}
                          disabled={!laneId || busyAction != null}
                          title="Restores changes and removes this stash entry"
                          onClick={() => {
                            if (!laneId) return;
                            void runAction("stash pop", async () => {
                              await window.ade.git.stashPop({ laneId, stashRef: stash.ref });
                              await refreshGitMeta(laneId);
                            });
                          }}
                        >
                          RESTORE
                        </button>
                        <button
                          type="button"
                          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                          disabled={!laneId || busyAction != null}
                          title="Restores changes but keeps the stash entry saved"
                          onClick={() => {
                            if (!laneId) return;
                            void runAction("stash apply", async () => {
                              await window.ade.git.stashApply({ laneId, stashRef: stash.ref });
                            });
                          }}
                        >
                          COPY TO WORKTREE
                        </button>
                        <button
                          type="button"
                          style={dangerButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                          disabled={!laneId || busyAction != null}
                          title="Permanently deletes this stash entry without restoring"
                          onClick={() => {
                            if (!laneId) return;
                            void runAction("stash drop", async () => {
                              await window.ade.git.stashDrop({ laneId, stashRef: stash.ref });
                              await refreshGitMeta(laneId);
                            });
                          }}
                        >
                          DELETE
                        </button>
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
                  {changes.staged.map((file) => renderFileRow(file, "staged"))}
                </div>
              ) : null}
              {changes.unstaged.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ padding: "0 8px 4px", ...LABEL_STYLE }}>UNSTAGED ({changes.unstaged.length})</div>
                  {changes.unstaged.map((file) => renderFileRow(file, "unstaged"))}
                </div>
              ) : null}
              {changes.staged.length === 0 && changes.unstaged.length === 0 ? (
                <div style={{ padding: 12, textAlign: "center", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, fontStyle: "italic" }}>
                  No changes
                </div>
              ) : null}
            </div>
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
            background: error ? `${COLORS.danger}15` : `${COLORS.accent}12`,
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
