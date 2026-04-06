import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitPullRequest, GitMerge, Stack as Layers, CheckCircle, Warning, CircleNotch, X, GitBranch, Sparkle, ArrowRight, ArrowLeft, Check, DotsSixVertical, Trash, ArrowUp, ArrowDown } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import type {
  MergeMethod,
  PrSummary,
  IntegrationProposal,
  IntegrationProposalStep,
  CreateIntegrationPrResult,
  GitUpstreamSyncStatus,
  GitBranchSummary,
  LaneSummary,
} from "../../../shared/types";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { isDirtyWorktreeErrorMessage, stripDirtyWorktreePrefix } from "./shared/dirtyWorktree";
import { branchNameFromRef, describePrTargetDiff, resolveLaneBaseBranch } from "./shared/laneBranchTargets";
import { buildLaneRebaseRecommendedLaneIds, describeLanePrIssues } from "./shared/lanePrWarnings";

type CreateMode = "normal" | "queue" | "integration";

/** Alias mapping from old `C` tokens to centralized COLORS. */
const C = {
  bgMain: COLORS.pageBg,
  bgCard: COLORS.cardBg,
  bgHeader: COLORS.recessedBg,
  bgInput: COLORS.recessedBg,
  border: COLORS.border,
  borderSubtle: COLORS.outlineBorder,
  textPrimary: COLORS.textPrimary,
  textSecondary: COLORS.textSecondary,
  textMuted: COLORS.textMuted,
  textDisabled: COLORS.textDim,
  accent: COLORS.accent,
  accentSubtleBg: COLORS.accentSubtle,
  accentBorder: COLORS.accentBorder,
  success: COLORS.success,
  warning: COLORS.warning,
  error: COLORS.danger,
  info: COLORS.info,
} as const;

const MERGE_METHODS: { id: MergeMethod; label: string; desc: string }[] = [
  { id: "squash", label: "Squash", desc: "Combine all commits into one. Clean, linear history." },
  { id: "merge", label: "Merge", desc: "Create a merge commit. Preserves individual commits and branch topology." },
  { id: "rebase", label: "Rebase", desc: "Replay commits on top of base. Linear history, keeps each commit." },
];

const MODES: { id: CreateMode; label: string; icon: React.ElementType; desc: string }[] = [
  { id: "normal", label: "Single PR", icon: GitPullRequest, desc: "Single lane creates one PR." },
  { id: "queue", label: "Queue workflow", icon: Layers, desc: "Multiple lanes targeting the same branch, landed sequentially." },
  { id: "integration", label: "Integration workflow", icon: GitMerge, desc: "Merge multiple lanes into one integration branch, then open a PR." },
];

/* ── label style helper ────────────────────────────────────────────── */
const labelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  color: C.textSecondary,
  marginBottom: 8,
  display: "block",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: C.bgInput,
  border: `1px solid ${C.borderSubtle}`,
  color: C.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "12px 16px",
  borderRadius: 0,
  outline: "none",
  transition: "border-color 0.15s",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  paddingLeft: 32,
  appearance: "none",
  WebkitAppearance: "none",
  cursor: "pointer",
  backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2371717A' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "none" as const,
};

const errorBannerStyle: React.CSSProperties = {
  background: `${C.error}0D`,
  border: `1px solid ${C.error}33`,
  borderRadius: 0,
  padding: "10px 14px",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
  color: C.error,
  whiteSpace: "pre-wrap",
  maxHeight: "200px",
  overflowY: "auto",
};

/** Regex for characters/patterns not allowed in git branch names. */
const INVALID_GIT_REF_RE = /[\s~^:?*\[\\]|\.{2}|^\/|\/$/;

function StepOutcome({ outcome }: { outcome: IntegrationProposalStep["outcome"] }) {
  if (outcome === "clean") return <CheckCircle size={14} weight="fill" style={{ color: C.success }} />;
  if (outcome === "conflict") return <Warning size={14} weight="fill" style={{ color: C.warning }} />;
  if (outcome === "blocked") return <Warning size={14} weight="fill" style={{ color: C.error }} />;
  return <div style={{ height: 14, width: 14, background: C.textDisabled, borderRadius: 0 }} />;
}

/* ── stepper bar ───────────────────────────────────────────────────── */
type StepperStep = { num: number; label: string };
const STEPPER_STEPS: StepperStep[] = [
  { num: 1, label: "BRANCH" },
  { num: 2, label: "DETAILS" },
  { num: 3, label: "REVIEW" },
];

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 0,
      padding: "16px 24px 12px",
      background: C.bgCard,
      borderBottom: `1px solid ${C.border}`,
    }}>
      {STEPPER_STEPS.map((s, i) => {
        const isActive = s.num === currentStep;
        const isCompleted = s.num < currentStep;

        return (
          <React.Fragment key={s.num}>
            {/* Connector line before (not for first) */}
            {i > 0 && (
              <div style={{
                flex: 1,
                height: 1,
                maxWidth: 48,
                borderTop: isCompleted
                  ? `2px solid ${C.success}`
                  : `2px dashed ${C.textDisabled}`,
                marginLeft: 8,
                marginRight: 8,
              }} />
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Circle */}
              <div style={{
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: isCompleted
                  ? `2px solid ${C.success}`
                  : isActive
                    ? `2px solid ${C.accent}`
                    : `2px dashed ${C.textDisabled}`,
                borderRadius: 0,
                background: isCompleted
                  ? `${C.success}18`
                  : isActive
                    ? C.accentSubtleBg
                    : "transparent",
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                fontWeight: 700,
                color: isCompleted
                  ? C.success
                  : isActive
                    ? C.accent
                    : C.textDisabled,
              }}>
                {isCompleted ? <Check size={14} weight="bold" /> : s.num}
              </div>
              {/* Label */}
              <span style={{
                fontSize: 10,
                fontWeight: isActive ? 700 : 500,
                fontFamily: "var(--font-sans)",
                textTransform: "uppercase" as const,
                letterSpacing: "1px",
                color: isCompleted
                  ? C.textMuted
                  : isActive
                    ? C.textPrimary
                    : C.textMuted,
              }}>
                {s.label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

type LaneWarningSummary = {
  laneId: string;
  laneName: string;
  messages: string[];
};

async function runWithDirtyWorktreeConfirmation<T>(args: {
  run: (allowDirtyWorktree: boolean) => Promise<T>;
  confirmMessage: string;
}): Promise<T> {
  try {
    return await args.run(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isDirtyWorktreeErrorMessage(message) || !window.confirm(`${stripDirtyWorktreePrefix(message)}\n\n${args.confirmMessage}`)) {
      throw error;
    }
    return await args.run(true);
  }
}

function buildLaneWarningSummaries(args: {
  selectedLaneIds: string[];
  lanes: Array<{ id: string; name: string }>;
  allLanes: LaneSummary[];
  laneWarningItemsById: Record<string, string[]>;
  targetBranch?: string;
  primaryBranchRef?: string | null;
}): LaneWarningSummary[] {
  return args.selectedLaneIds
    .map((laneId) => {
      const lane = args.lanes.find((entry) => entry.id === laneId);
      const baseMessages = args.laneWarningItemsById[laneId] ?? [];
      const targetDiffMessage = describePrTargetDiff({
        lane: args.allLanes.find((entry) => entry.id === laneId) ?? null,
        lanes: args.allLanes,
        targetBranch: args.targetBranch ?? null,
        primaryBranchRef: args.primaryBranchRef ?? null,
      });
      const messages = targetDiffMessage ? [...baseMessages, targetDiffMessage] : baseMessages;
      if (!lane || messages.length === 0) return null;
      return { laneId, laneName: lane.name, messages };
    })
    .filter((item): item is LaneWarningSummary => item != null);
}

function outcomeColor(outcome: string): string {
  if (outcome === "clean") return C.success;
  if (outcome === "conflict") return C.warning;
  return C.error;
}

function getCreateActionLabel(mode: CreateMode, busy: boolean): string {
  if (busy) {
    return mode === "integration" ? "SAVING..." : "CREATING...";
  }
  return mode === "integration" ? "SAVE PROPOSAL" : "CREATE PR";
}

function resolveDefaultBaseBranchForLane(args: {
  lane: LaneSummary | null;
  lanes: LaneSummary[];
  primaryBranchRef?: string | null;
}): string {
  return resolveLaneBaseBranch(args);
}

export function reorderQueueLaneIds(queueLaneIds: string[], draggedLaneId: string, targetLaneId: string): string[] {
  const draggedIndex = queueLaneIds.indexOf(draggedLaneId);
  const targetIndex = queueLaneIds.indexOf(targetLaneId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return queueLaneIds;

  const next = [...queueLaneIds];
  const [removed] = next.splice(draggedIndex, 1);
  // After removing the dragged item, adjust target index if dragged was above
  const adjustedTarget = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(adjustedTarget, 0, removed);
  return next;
}

function LaneCheckboxList({
  lanes: displayLanes,
  selectedIds,
  warningItemsById,
  onToggle,
  maxHeight = 240,
}: {
  lanes: Array<{ id: string; name: string; branchRef: string }>;
  selectedIds: string[];
  warningItemsById: Record<string, string[]>;
  onToggle: (laneId: string) => void;
  maxHeight?: number;
}) {
  return (
    <div style={{
      maxHeight,
      overflowY: "auto",
      background: C.bgInput,
      border: `1px solid ${C.border}`,
      borderRadius: 0,
      padding: 8,
    }}>
      {displayLanes.map((lane) => {
        const checked = selectedIds.includes(lane.id);
        const warningCount = warningItemsById[lane.id]?.length ?? 0;
        return (
          <label
            key={lane.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              cursor: "pointer",
              background: checked ? C.accentSubtleBg : "transparent",
              borderRadius: 0,
              transition: "background 0.1s",
              marginBottom: 2,
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(lane.id)}
              style={{ accentColor: C.accent }}
            />
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 600,
              color: C.textPrimary,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {lane.name}
            </span>
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: C.textMuted,
            }}>
              {lane.branchRef}
            </span>
            {warningCount > 0 ? (
              <span
                title={`${warningCount} readiness warning${warningCount === 1 ? "" : "s"}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 10,
                  fontFamily: MONO_FONT,
                  color: C.warning,
                  background: `${C.warning}18`,
                  border: `1px solid ${C.warning}30`,
                  padding: "2px 6px",
                }}
              >
                <Warning size={10} weight="fill" />
                {warningCount}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

function LaneWarningPanel({
  items,
  loading,
  rebaseLaneIds,
  onOpenRebase,
}: {
  items: LaneWarningSummary[];
  loading: boolean;
  rebaseLaneIds: string[];
  onOpenRebase: (laneId: string) => void;
}) {
  if (!items.length && !loading) return null;
  const primaryRebaseLaneId = rebaseLaneIds[0] ?? null;
  return (
    <div
      style={{
        marginTop: 12,
        background: `${C.warning}12`,
        border: `1px solid ${C.warning}30`,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <Warning size={14} weight="fill" style={{ color: C.warning, marginTop: 1, flexShrink: 0 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: C.warning,
            }}
          >
            Lane Needs Attention
          </div>
          {items.map((item) => (
            <div key={item.laneId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textPrimary, fontFamily: MONO_FONT }}>
                {item.laneName}
              </div>
              {item.messages.map((message) => (
                <div key={`${item.laneId}:${message}`} style={{ fontSize: 11, color: C.textSecondary, lineHeight: "16px" }}>
                  {message}
                </div>
              ))}
            </div>
          ))}
          {loading ? (
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO_FONT }}>
              Checking remote sync status...
            </div>
          ) : null}
          {primaryRebaseLaneId ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => onOpenRebase(primaryRebaseLaneId)}
                style={{
                  background: "transparent",
                  border: `1px solid ${C.warning}45`,
                  color: C.warning,
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                Open Rebase Tab
              </button>
              <span style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO_FONT }}>
                Review rebase status before PR creation{rebaseLaneIds.length > 1 ? ` (${rebaseLaneIds.length} lanes)` : ""}.
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── main component ────────────────────────────────────────────────── */

export function CreatePrModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const lanes = useAppStore((s) => s.lanes);
  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  const [mode, setMode] = React.useState<CreateMode>("normal");

  // Internal numeric step for stepper (1=BRANCH, 2=DETAILS, 3=REVIEW)
  const [numericStep, setNumericStep] = React.useState(1);

  // Shared
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");

  // Normal PR
  const [normalLaneId, setNormalLaneId] = React.useState<string>("");
  const [normalTitle, setNormalTitle] = React.useState("");
  const [normalDraft, setNormalDraft] = React.useState(false);
  const [normalBaseBranch, setNormalBaseBranch] = React.useState("");
  const normalBaseBranchDefaultRef = React.useRef("");

  // Queue PRs
  const [queueLaneIds, setQueueLaneIds] = React.useState<string[]>([]);
  const [queueDraft, setQueueDraft] = React.useState(false);
  const [queueDragLaneId, setQueueDragLaneId] = React.useState<string | null>(null);
  const [queueTargetBranch, setQueueTargetBranch] = React.useState("");

  // Body & AI draft
  const [normalBody, setNormalBody] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);

  // Integration PR
  const [integrationSources, setIntegrationSources] = React.useState<string[]>([]);
  const [integrationBaseBranch, setIntegrationBaseBranch] = React.useState("");
  const [integrationName, setIntegrationName] = React.useState("");
  const [integrationTitle, setIntegrationTitle] = React.useState("");
  const [integrationBody, setIntegrationBody] = React.useState("");
  const [integrationDraft, setIntegrationDraft] = React.useState(false);
  const [integrationMergeIntoLaneId, setIntegrationMergeIntoLaneId] = React.useState("");
  const [proposal, setProposal] = React.useState<IntegrationProposal | null>(null);
  const [simulating, setSimulating] = React.useState(false);
  const [laneSyncStatusById, setLaneSyncStatusById] = React.useState<Record<string, GitUpstreamSyncStatus | null>>({});
  const [laneSyncLoadingById, setLaneSyncLoadingById] = React.useState<Record<string, boolean>>({});

  const [draftError, setDraftError] = React.useState<string | null>(null);

  // Available branches for target-branch dropdowns
  const [availableBranches, setAvailableBranches] = React.useState<GitBranchSummary[]>([]);
  const [branchLoadError, setBranchLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !primaryLane) return;
    let cancelled = false;
    setBranchLoadError(null);
    window.ade.git.listBranches({ laneId: primaryLane.id })
      .then((branches) => {
        if (!cancelled) setAvailableBranches(branches);
      })
      .catch((err: unknown) => {
        console.error("[CreatePrModal] listBranches failed", { laneId: primaryLane.id, err });
        if (!cancelled) {
          setBranchLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => { cancelled = true; };
  }, [open, primaryLane?.id]);

  /** Deduplicated list of branch names suitable for a target-branch dropdown. */
  const targetBranchOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const b of availableBranches) {
      // For remote branches like "origin/main", strip the remote prefix
      const name = b.isRemote
        ? b.name.replace(/^[^/]+\//, "")
        : b.name;
      if (!seen.has(name)) {
        seen.add(name);
        options.push(name);
      }
    }
    return options.sort((a, b) => a.localeCompare(b));
  }, [availableBranches]);

  const normalBranchSelectOptions = React.useMemo(() => {
    const v = normalBaseBranch.trim();
    if (!v.length) return targetBranchOptions;
    return [v, ...targetBranchOptions.filter((b) => b !== v)];
  }, [targetBranchOptions, normalBaseBranch]);

  const queueBranchSelectOptions = React.useMemo(() => {
    const v = queueTargetBranch.trim();
    if (!v.length) return targetBranchOptions;
    return [v, ...targetBranchOptions.filter((b) => b !== v)];
  }, [targetBranchOptions, queueTargetBranch]);

  const integrationBranchSelectOptions = React.useMemo(() => {
    const v = integrationBaseBranch.trim();
    if (!v.length) return targetBranchOptions;
    return [v, ...targetBranchOptions.filter((b) => b !== v)];
  }, [targetBranchOptions, integrationBaseBranch]);

  const handleDraftAI = async (laneId: string) => {
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await window.ade.prs.draftDescription({ laneId });
      if (mode === "normal") {
        setNormalTitle(result.title);
        setNormalBody(result.body);
      }
    } catch (err: unknown) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrafting(false);
    }
  };

  // Execute
  const [busy, setBusy] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<PrSummary[] | null>(null);
  const [integrationResult, setIntegrationResult] = React.useState<CreateIntegrationPrResult | null>(null);
  const [integrationProgress, setIntegrationProgress] = React.useState<string | null>(null);
  const [integrationBranchError, setIntegrationBranchError] = React.useState<string | null>(null);
  const [queueErrors, setQueueErrors] = React.useState<Array<{ laneId: string; error: string }>>([]);

  const openRebaseTab = React.useCallback((laneId: string) => {
    onOpenChange(false);
    window.location.hash = `#/prs?tab=rebase&laneId=${encodeURIComponent(laneId)}`;
  }, [onOpenChange]);

  // Reset on close
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setMode("normal");
      setNumericStep(1);
      setMergeMethod("squash");
      setNormalLaneId("");
      setNormalBaseBranch("");
      normalBaseBranchDefaultRef.current = "";
      setNormalTitle("");
      setNormalDraft(false);
      setQueueLaneIds([]);
      setQueueDraft(false);
      setQueueDragLaneId(null);
      setQueueTargetBranch("");
      setBusy(false);
      setExecError(null);
      setResults(null);
      setNormalBody("");
      setDrafting(false);
      setDraftError(null);
      setIntegrationSources([]);
      setIntegrationBaseBranch("");
      setIntegrationMergeIntoLaneId("");
      setIntegrationName("");
      setIntegrationTitle("");
      setIntegrationBody("");
      setIntegrationDraft(false);
      setProposal(null);
      setSimulating(false);
      setIntegrationResult(null);
      setIntegrationProgress(null);
      setIntegrationBranchError(null);
      setQueueErrors([]);
      setAvailableBranches([]);
      setBranchLoadError(null);
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const laneIds = lanes.filter((lane) => lane.laneType !== "primary").map((lane) => lane.id);
    if (laneIds.length === 0) {
      setLaneSyncStatusById({});
      setLaneSyncLoadingById({});
      return;
    }
    let cancelled = false;
    setLaneSyncLoadingById(Object.fromEntries(laneIds.map((laneId) => [laneId, true])));
    void Promise.allSettled(
      laneIds.map(async (laneId) => ({
        laneId,
        status: await window.ade.git.getSyncStatus({ laneId }),
      }))
    ).then((results) => {
      if (cancelled) return;
      const nextStatuses: Record<string, GitUpstreamSyncStatus | null> = {};
      const nextLoading: Record<string, boolean> = {};
      for (const laneId of laneIds) {
        nextLoading[laneId] = false;
      }
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        nextStatuses[result.value.laneId] = result.value.status;
      }
      setLaneSyncStatusById(nextStatuses);
      setLaneSyncLoadingById(nextLoading);
    });
    return () => {
      cancelled = true;
    };
  }, [open, lanes]);

  const selectedNormalLane = React.useMemo(
    () => lanes.find((lane) => lane.id === normalLaneId) ?? null,
    [lanes, normalLaneId],
  );

  React.useEffect(() => {
    if (!open) return;
    const primaryBranch = branchNameFromRef(primaryLane?.branchRef ?? "main");
    setQueueTargetBranch((current) => current || primaryBranch);
    setIntegrationBaseBranch((current) => current || primaryBranch);
  }, [open, primaryLane?.branchRef]);

  React.useEffect(() => {
    if (!open) return;
    if (!selectedNormalLane) {
      normalBaseBranchDefaultRef.current = "";
      setNormalBaseBranch("");
      return;
    }
    const nextDefault = resolveDefaultBaseBranchForLane({
      lane: selectedNormalLane,
      lanes,
      primaryBranchRef: primaryLane?.branchRef ?? null,
    });
    setNormalBaseBranch((current) => {
      const trimmedCurrent = current.trim();
      const previousDefault = normalBaseBranchDefaultRef.current;
      if (trimmedCurrent.length === 0 || trimmedCurrent === previousDefault) {
        normalBaseBranchDefaultRef.current = nextDefault;
        return nextDefault;
      }
      return current;
    });
  }, [open, selectedNormalLane, lanes, primaryLane?.branchRef]);

  const handleSimulate = async () => {
    if (integrationSources.length === 0) return;
    setSimulating(true);
    setExecError(null);
    setProposal(null);
    try {
      const trimmedIntegrationBaseBranch = integrationBaseBranch.trim();
      const baseBranch = trimmedIntegrationBaseBranch || branchNameFromRef(primaryLane?.branchRef ?? "main");
      const mergeInto = integrationMergeIntoLaneId.trim();
      if (mergeInto && integrationSources.includes(mergeInto)) {
        setExecError("Merge-into lane cannot be one of the source lanes.");
        return;
      }
      const result = await window.ade.prs.simulateIntegration({
        sourceLaneIds: integrationSources,
        baseBranch,
        mergeIntoLaneId: mergeInto || null,
      });
      setProposal(result);
      // Auto-generate a name if empty
      if (!integrationName) {
        setIntegrationName(`integration/${Date.now().toString(36)}`);
      }
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimulating(false);
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    setExecError(null);
    setQueueErrors([]);
    setIntegrationProgress(null);
    let lastProgressLabel: string | null = null;
    try {
      if (mode === "normal") {
        const lane = lanes.find((l) => l.id === normalLaneId);
        const pr = await runWithDirtyWorktreeConfirmation({
          confirmMessage: "Continue and create the PR anyway?",
          run: async (allowDirtyWorktree) => await window.ade.prs.createFromLane({
            laneId: normalLaneId,
            title: normalTitle || lane?.name || "PR",
            body: normalBody,
            draft: normalDraft,
            ...(normalBaseBranch.trim() ? { baseBranch: normalBaseBranch.trim() } : {}),
            ...(allowDirtyWorktree ? { allowDirtyWorktree: true } : {})
          })
        });
        setResults([pr]);
        setNumericStep(3);
      } else if (mode === "queue") {
        const trimmedQueueTargetBranch = (queueTargetBranch ?? "").trim();
        const baseBranch = (trimmedQueueTargetBranch || branchNameFromRef(primaryLane?.branchRef ?? "main")).trim();
        const result = await runWithDirtyWorktreeConfirmation({
          confirmMessage: "Continue and create the queue PRs anyway?",
          run: async (allowDirtyWorktree) => await window.ade.prs.createQueue({
            laneIds: queueLaneIds,
            targetBranch: baseBranch,
            draft: queueDraft,
            ...(allowDirtyWorktree ? { allowDirtyWorktree: true } : {})
          })
        });
        if (result.errors.length > 0) {
          setQueueErrors(result.errors);
        }
        setResults(result.prs);
        setNumericStep(3);
      } else if (mode === "integration") {
        if (!proposal) {
          setExecError("Run a simulation first to create a proposal.");
          setBusy(false);
          return;
        }
        lastProgressLabel = "Saving proposal";
        setIntegrationProgress("Saving proposal...");
        await window.ade.prs.updateProposal({
          proposalId: proposal.proposalId,
          title: integrationTitle || "Integration workflow",
          body: integrationBody,
          draft: integrationDraft,
          integrationLaneName: integrationName || `integration/${Date.now().toString(36)}`,
          preferredIntegrationLaneId: integrationMergeIntoLaneId.trim() || null,
        });
        lastProgressLabel = "Creating integration lane";
        setIntegrationProgress("Creating integration lane...");
        await runWithDirtyWorktreeConfirmation({
          confirmMessage: "Continue and prepare the integration lane anyway?",
          run: async (allowDirtyWorktree) => window.ade.prs.createIntegrationLaneForProposal({
            proposalId: proposal.proposalId,
            ...(allowDirtyWorktree ? { allowDirtyWorktree: true } : {}),
          }),
        });
        setIntegrationProgress(null);
        // No PR created — proposal saved for later commit from Integration tab
        setResults([]);
        setNumericStep(3);
      }
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = rawMsg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      if (mode === "integration" && lastProgressLabel) {
        setExecError(`Failed during "${lastProgressLabel}": ${msg}`);
      } else {
        setExecError(msg);
      }
      setIntegrationProgress(null);
      // Stay on current step so user can see the error and retry
    } finally {
      setBusy(false);
    }
  };

  const nonPrimaryLanes = React.useMemo(() => lanes.filter((l) => l.laneType !== "primary"), [lanes]);

  const integrationMergeIntoOptions = React.useMemo(
    () => [...nonPrimaryLanes].sort((a, b) => a.name.localeCompare(b.name)),
    [nonPrimaryLanes],
  );

  React.useEffect(() => {
    if (!integrationMergeIntoLaneId) return;
    if (integrationSources.includes(integrationMergeIntoLaneId)) {
      setIntegrationMergeIntoLaneId("");
      setProposal(null);
    }
  }, [integrationMergeIntoLaneId, integrationSources]);

  const toggleQueueLane = (laneId: string) => {
    setQueueLaneIds((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId]
    );
  };

  const handleQueueLaneDrop = React.useCallback((targetLaneId: string) => {
    if (!queueDragLaneId || queueDragLaneId === targetLaneId) {
      setQueueDragLaneId(null);
      return;
    }
    setQueueLaneIds((prev) => reorderQueueLaneIds(prev, queueDragLaneId, targetLaneId));
    setQueueDragLaneId(null);
  }, [queueDragLaneId]);

  const toggleIntegrationSource = (laneId: string) => {
    setIntegrationSources((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId]
    );
    // Clear proposal when sources change
    setProposal(null);
  };

  const integrationNameTrimmed = integrationName.trim();
  const integrationBranchValid = integrationNameTrimmed.length > 0 && !INVALID_GIT_REF_RE.test(integrationNameTrimmed) && !integrationNameTrimmed.startsWith("/") && !integrationNameTrimmed.endsWith("/") && !integrationNameTrimmed.endsWith(".lock") && !integrationNameTrimmed.endsWith(".");

  const canCreateIntegration =
    integrationSources.length >= 2 &&
    !!proposal &&
    proposal.overallOutcome !== "blocked" &&
    integrationBranchValid;

  /* Can user advance to step 2 or submit from step 2? Same readiness check. */
  const canProceed =
    (mode === "normal" && !!normalLaneId) ||
    (mode === "queue" && queueLaneIds.length > 0) ||
    (mode === "integration" && canCreateIntegration);

  const goToStep2 = () => {
    setExecError(null);
    setDraftError(null);
    setNumericStep(2);
  };

  const goBackToStep1 = () => {
    setExecError(null);
    setDraftError(null);
    setNumericStep(1);
  };

  /* ── selected lane info for comparison section ──────────────────── */
  const laneWarningItemsById = React.useMemo(() => {
    return Object.fromEntries(
      nonPrimaryLanes.map((lane) => [
        lane.id,
        describeLanePrIssues(lane, laneSyncStatusById[lane.id] ?? null),
      ])
    ) as Record<string, string[]>;
  }, [laneSyncStatusById, nonPrimaryLanes]);
  const selectedNormalWarnings = React.useMemo<LaneWarningSummary[]>(() => {
    if (!selectedNormalLane) return [];
    const baseMessages = laneWarningItemsById[selectedNormalLane.id] ?? [];
    const targetDiffMessage = describePrTargetDiff({
      lane: selectedNormalLane,
      lanes,
      targetBranch: normalBaseBranch,
      primaryBranchRef: primaryLane?.branchRef ?? null,
    });
    const messages = targetDiffMessage ? [...baseMessages, targetDiffMessage] : baseMessages;
    if (!messages.length) return [];
    return [{ laneId: selectedNormalLane.id, laneName: selectedNormalLane.name, messages }];
  }, [laneWarningItemsById, lanes, normalBaseBranch, primaryLane?.branchRef, selectedNormalLane]);
  const selectedQueueWarnings = React.useMemo<LaneWarningSummary[]>(() => {
    return buildLaneWarningSummaries({
      selectedLaneIds: queueLaneIds,
      lanes,
      allLanes: nonPrimaryLanes,
      laneWarningItemsById,
      targetBranch: queueTargetBranch,
      primaryBranchRef: primaryLane?.branchRef ?? null,
    });
  }, [laneWarningItemsById, lanes, nonPrimaryLanes, primaryLane?.branchRef, queueLaneIds, queueTargetBranch]);
  const selectedIntegrationWarnings = React.useMemo<LaneWarningSummary[]>(() => {
    return buildLaneWarningSummaries({
      selectedLaneIds: integrationSources,
      lanes,
      allLanes: nonPrimaryLanes,
      laneWarningItemsById,
      targetBranch: integrationBaseBranch,
      primaryBranchRef: primaryLane?.branchRef ?? null,
    });
  }, [integrationBaseBranch, integrationSources, laneWarningItemsById, lanes, nonPrimaryLanes, primaryLane?.branchRef]);
  const selectedNormalLoading = Boolean(normalLaneId) && laneSyncLoadingById[normalLaneId] === true;
  const selectedQueueLoading = queueLaneIds.some((laneId) => laneSyncLoadingById[laneId] === true);
  const selectedIntegrationLoading = integrationSources.some((laneId) => laneSyncLoadingById[laneId] === true);
  const selectedNormalRebaseLaneIds = React.useMemo(
    () => buildLaneRebaseRecommendedLaneIds({ lanes, selectedLaneIds: normalLaneId ? [normalLaneId] : [] }),
    [lanes, normalLaneId],
  );
  const selectedQueueRebaseLaneIds = React.useMemo(
    () => buildLaneRebaseRecommendedLaneIds({ lanes, selectedLaneIds: queueLaneIds }),
    [lanes, queueLaneIds],
  );
  const selectedIntegrationRebaseLaneIds = React.useMemo(
    () => buildLaneRebaseRecommendedLaneIds({ lanes, selectedLaneIds: integrationSources }),
    [integrationSources, lanes],
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && busy) return; onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(8px)",
          }}
        />
        <Dialog.Content
          style={{
            position: "fixed",
            left: "50%",
            top: "8%",
            zIndex: 50,
            width: "min(560px, calc(100vw - 24px))",
            transform: "translateX(-50%)",
            borderRadius: 0,
            background: C.bgCard,
            border: `1px solid ${C.border}`,
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            outline: "none",
            maxHeight: "84vh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* ── Modal Header ────────────────────────────────────── */}
          <div style={{
            height: 56,
            minHeight: 56,
            background: C.bgHeader,
            display: "flex",
            alignItems: "center",
            padding: "0 20px",
            borderBottom: `1px solid ${C.border}`,
            gap: 12,
          }}>
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 700,
              color: C.accent,
            }}>
              01
            </span>
            <Dialog.Title style={{
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              fontWeight: 700,
              color: C.textPrimary,
              margin: 0,
              flex: 1,
            }}>
              CREATE PULL REQUEST
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                disabled={busy}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: busy ? "not-allowed" : "pointer",
                  color: busy ? C.textDisabled : C.textMuted,
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: busy ? 0.4 : 1,
                }}
                aria-label="Close"
              >
                <X size={18} weight="bold" />
              </button>
            </Dialog.Close>
          </div>

          {/* Visually hidden description for accessibility */}
          <Dialog.Description style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
            {numericStep === 1 && "Configure branch and PR type"}
            {numericStep === 2 && "Enter PR details"}
            {numericStep === 3 && "Review results"}
          </Dialog.Description>

          {/* ── Stepper ─────────────────────────────────────────── */}
          <Stepper currentStep={numericStep} />

          {branchLoadError ? (
            <div role="alert" style={{ padding: "8px 24px", fontSize: 11, color: C.error, background: `${C.error}10` }}>
              Could not load branch list: {branchLoadError}
            </div>
          ) : null}

          {/* ── Scrollable Body ─────────────────────────────────── */}
          <div style={{
            flex: 1,
            overflowY: "auto",
            padding: 24,
          }}>

            {/* ════════════════════════════════════════════════════ */}
            {/* STEP 1 — BRANCH                                     */}
            {/* ════════════════════════════════════════════════════ */}
            {numericStep === 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

                {/* PR Type Selector Cards */}
                <div>
                  <span style={labelStyle}>PR TYPE</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {MODES.map((m) => {
                      const Icon = m.icon;
                      const selected = mode === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setMode(m.id)}
                          style={{
                            flex: 1,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 6,
                            padding: "14px 8px",
                            background: selected ? C.accentSubtleBg : "transparent",
                            border: selected
                              ? `1px solid ${C.accent}`
                              : `1px solid ${C.borderSubtle}`,
                            borderRadius: 0,
                            cursor: "pointer",
                            transition: "all 0.15s",
                            outline: "none",
                          }}
                        >
                          <Icon
                            size={20}
                            weight="regular"
                            style={{ color: selected ? C.accent : C.textMuted }}
                          />
                          <span style={{
                            fontSize: 10,
                            fontWeight: 700,
                            fontFamily: "var(--font-sans)",
                            textTransform: "uppercase" as const,
                            letterSpacing: "1px",
                            color: selected ? C.textPrimary : C.textSecondary,
                          }}>
                            {m.label}
                          </span>
                          <span style={{
                            fontSize: 10,
                            fontFamily: "var(--font-sans)",
                            color: C.textMuted,
                            textAlign: "center",
                            lineHeight: "14px",
                          }}>
                            {m.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ── Normal mode: Source / Target branch ─────────── */}
                {mode === "normal" && (
                  <>
                    <div>
                      <span style={labelStyle}>SOURCE BRANCH</span>
                      <div style={{ position: "relative" }}>
                        <GitBranch
                          size={14}
                          weight="bold"
                          style={{
                            position: "absolute",
                            left: 12,
                            top: "50%",
                            transform: "translateY(-50%)",
                            color: C.textMuted,
                            pointerEvents: "none",
                          }}
                        />
                        <select
                          value={normalLaneId}
                          onChange={(e) => setNormalLaneId(e.target.value)}
                          style={{
                            ...inputStyle,
                            paddingLeft: 32,
                            appearance: "none",
                            WebkitAppearance: "none",
                            cursor: "pointer",
                            backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2371717A' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                            backgroundRepeat: "no-repeat",
                            backgroundPosition: "right 12px center",
                          }}
                          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                        >
                          <option value="" disabled>Select lane...</option>
                          {nonPrimaryLanes.map((lane) => (
                            <option key={lane.id} value={lane.id}>
                              {lane.name} ({lane.branchRef})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <span style={labelStyle}>TARGET BRANCH</span>
                      <div style={{ position: "relative" }}>
                        <GitBranch
                          size={14}
                          weight="bold"
                          style={{
                            position: "absolute",
                            left: 12,
                            top: "50%",
                            transform: "translateY(-50%)",
                            color: C.textMuted,
                            pointerEvents: "none",
                            zIndex: 1,
                          }}
                        />
                        <input
                          list="normalBranchOptions"
                          value={normalBaseBranch}
                          onChange={(e) => setNormalBaseBranch(e.target.value)}
                          aria-label="Target branch"
                          placeholder="Type or select a branch"
                          style={selectStyle}
                          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                        />
                        <datalist id="normalBranchOptions">
                          {normalBranchSelectOptions.map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      </div>
                    </div>

                    {/* Comparison stats */}
                    {selectedNormalLane && (
                      <div>
                        <span style={labelStyle}>COMPARISON</span>
                        <div style={{ display: "flex", gap: 12 }}>
                          {[
                            { label: "AHEAD", value: selectedNormalLane.status.ahead, color: C.textPrimary },
                            { label: "BEHIND", value: selectedNormalLane.status.behind, color: C.textSecondary },
                            { label: "STATUS", value: selectedNormalLane.status.dirty ? "DIRTY" : "CLEAN", color: selectedNormalLane.status.dirty ? C.warning : C.success },
                          ].map((stat) => (
                            <div
                              key={stat.label}
                              style={{
                                flex: 1,
                                background: C.bgInput,
                                border: `1px solid ${C.border}`,
                                borderRadius: 0,
                                padding: "12px 16px",
                                textAlign: "center",
                              }}
                            >
                              <div style={{
                                fontFamily: "var(--font-sans)",
                                fontSize: 20,
                                fontWeight: 700,
                                color: stat.color,
                              }}>
                                {stat.value}
                              </div>
                              <div style={{
                                fontSize: 9,
                                fontWeight: 700,
                                fontFamily: "var(--font-sans)",
                                textTransform: "uppercase" as const,
                                letterSpacing: "1px",
                                color: C.textMuted,
                                marginTop: 4,
                              }}>
                                {stat.label}
                              </div>
                            </div>
                          ))}
                        </div>
                        <LaneWarningPanel
                          items={selectedNormalWarnings}
                          loading={selectedNormalLoading}
                          rebaseLaneIds={selectedNormalRebaseLaneIds}
                          onOpenRebase={openRebaseTab}
                        />
                      </div>
                    )}
                  </>
                )}

                {/* ── Queue mode: Lane selection ─────────────────── */}
                {mode === "queue" && (
                  <div>
                    <span style={labelStyle}>BUILD QUEUE</span>
                    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                      <div>
                        <div style={{ ...labelStyle, marginBottom: 6 }}>AVAILABLE LANES</div>
                        <LaneCheckboxList
                          lanes={nonPrimaryLanes}
                          selectedIds={queueLaneIds}
                          warningItemsById={laneWarningItemsById}
                          onToggle={toggleQueueLane}
                        />
                        <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, fontFamily: MONO_FONT }}>
                          Select lanes to add them to the queue.
                        </div>
                      </div>

                      <div>
                        <div style={{ ...labelStyle, marginBottom: 6 }}>QUEUE ORDER</div>
                        <div style={{
                          minHeight: 240,
                          background: C.bgInput,
                          border: `1px solid ${C.border}`,
                          borderRadius: 0,
                          padding: 8,
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}>
                          {queueLaneIds.length === 0 ? (
                            <div style={{
                              flex: 1,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: 16,
                              color: C.textMuted,
                              fontFamily: MONO_FONT,
                              fontSize: 11,
                              textAlign: "center",
                              border: `1px dashed ${C.borderSubtle}`,
                            }}>
                              Add lanes, then drag this list to set landing order.
                            </div>
                          ) : (
                            queueLaneIds.map((laneId, idx) => {
                              const lane = lanes.find((entry) => entry.id === laneId);
                              const isDragged = queueDragLaneId === laneId;
                              return (
                                <div
                                  key={laneId}
                                  draggable={queueLaneIds.length > 1}
                                  data-queue-lane-id={laneId}
                                  onDragStart={() => setQueueDragLaneId(laneId)}
                                  onDragEnd={() => setQueueDragLaneId(null)}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={() => handleQueueLaneDrop(laneId)}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 10,
                                    padding: "10px 12px",
                                    border: `1px solid ${isDragged ? C.accent : C.borderSubtle}`,
                                    background: isDragged ? C.accentSubtleBg : "transparent",
                                    opacity: isDragged ? 0.7 : 1,
                                  }}
                                >
                                  <DotsSixVertical size={14} style={{ color: C.textMuted, cursor: "grab", flexShrink: 0 }} />
                                  <span style={{
                                    minWidth: 24,
                                    color: C.accent,
                                    fontFamily: MONO_FONT,
                                    fontSize: 11,
                                    fontWeight: 700,
                                  }}>
                                    #{idx + 1}
                                  </span>
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{
                                      fontFamily: MONO_FONT,
                                      fontSize: 12,
                                      fontWeight: 700,
                                      color: C.textPrimary,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}>
                                      {lane?.name ?? laneId}
                                    </div>
                                    <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: C.textMuted }}>
                                      {lane?.branchRef ?? "---"}
                                    </div>
                                  </div>
                                  {idx > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => setQueueLaneIds((prev) => {
                                        const next = [...prev];
                                        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                        return next;
                                      })}
                                      style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        padding: 4,
                                        background: "transparent",
                                        border: "none",
                                        color: C.textMuted,
                                        cursor: "pointer",
                                        flexShrink: 0,
                                      }}
                                      title="Move up"
                                    >
                                      <ArrowUp size={13} />
                                    </button>
                                  )}
                                  {idx < queueLaneIds.length - 1 && (
                                    <button
                                      type="button"
                                      onClick={() => setQueueLaneIds((prev) => {
                                        const next = [...prev];
                                        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                        return next;
                                      })}
                                      style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        padding: 4,
                                        background: "transparent",
                                        border: "none",
                                        color: C.textMuted,
                                        cursor: "pointer",
                                        flexShrink: 0,
                                      }}
                                      title="Move down"
                                    >
                                      <ArrowDown size={13} />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setQueueLaneIds((prev) => prev.filter((id) => id !== laneId))}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      padding: 4,
                                      background: "transparent",
                                      border: "none",
                                      color: C.textMuted,
                                      cursor: "pointer",
                                      flexShrink: 0,
                                    }}
                                    title="Remove lane from queue"
                                  >
                                    <Trash size={13} />
                                  </button>
                                </div>
                              );
                            })
                          )}
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, fontFamily: MONO_FONT }}>
                          Drag queued lanes to choose the exact PR creation and landing order.
                        </div>
                      </div>
                    </div>
                    <LaneWarningPanel
                      items={selectedQueueWarnings}
                      loading={selectedQueueLoading}
                      rebaseLaneIds={selectedQueueRebaseLaneIds}
                      onOpenRebase={openRebaseTab}
                    />
                    {queueLaneIds.length > 0 && (
                      <div style={{
                        marginTop: 8,
                        fontSize: 11,
                        fontFamily: "var(--font-sans)",
                        color: C.textSecondary,
                      }}>
                        {queueLaneIds.length} lane{queueLaneIds.length !== 1 ? "s" : ""} selected
                      </div>
                    )}
                    <div style={{ marginTop: 12 }}>
                      <span style={labelStyle}>TARGET BRANCH</span>
                      <div style={{ position: "relative" }}>
                        <GitBranch
                          size={14}
                          weight="bold"
                          style={{
                            position: "absolute",
                            left: 12,
                            top: "50%",
                            transform: "translateY(-50%)",
                            color: C.textMuted,
                            pointerEvents: "none",
                            zIndex: 1,
                          }}
                        />
                        <input
                          list="queueBranchOptions"
                          value={queueTargetBranch}
                          onChange={(e) => setQueueTargetBranch(e.target.value)}
                          aria-label="Target branch"
                          placeholder="Type or select a branch"
                          style={selectStyle}
                          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                        />
                        <datalist id="queueBranchOptions">
                          {queueBranchSelectOptions.map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Integration mode: Source lanes + simulation ─── */}
                {mode === "integration" && (
                  <>
                    <div>
                      <span style={labelStyle}>TARGET BRANCH</span>
                      <div style={{ position: "relative" }}>
                        <GitBranch
                          size={14}
                          weight="bold"
                          style={{
                            position: "absolute",
                            left: 12,
                            top: "50%",
                            transform: "translateY(-50%)",
                            color: C.textMuted,
                            pointerEvents: "none",
                            zIndex: 1,
                          }}
                        />
                        <input
                          list="integrationBranchOptions"
                          value={integrationBaseBranch}
                          onChange={(e) => {
                            setIntegrationBaseBranch(e.target.value);
                            setProposal(null);
                          }}
                          aria-label="Target branch"
                          placeholder="Type or select a branch"
                          style={selectStyle}
                          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                        />
                        <datalist id="integrationBranchOptions">
                          {integrationBranchSelectOptions.map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      </div>
                    </div>

                    <div>
                      <span style={labelStyle}>SOURCE LANES TO INTEGRATE (SELECT 2+)</span>
                      <LaneCheckboxList
                        lanes={nonPrimaryLanes}
                        selectedIds={integrationSources}
                        warningItemsById={laneWarningItemsById}
                        onToggle={toggleIntegrationSource}
                        maxHeight={200}
                      />
                      <LaneWarningPanel
                        items={selectedIntegrationWarnings}
                        loading={selectedIntegrationLoading}
                        rebaseLaneIds={selectedIntegrationRebaseLaneIds}
                        onOpenRebase={openRebaseTab}
                      />
                    </div>

                    <div>
                      <span style={labelStyle}>MERGE INTO (OPTIONAL)</span>
                      <select
                        aria-label="Merge integration into existing lane"
                        value={integrationMergeIntoLaneId}
                        onChange={(e) => {
                          setIntegrationMergeIntoLaneId(e.target.value);
                          setProposal(null);
                        }}
                        style={selectStyle}
                        onFocus={(ev) => { ev.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(ev) => { ev.currentTarget.style.borderColor = C.borderSubtle; }}
                      >
                        <option value="">New integration lane</option>
                        {integrationMergeIntoOptions.map((lane) => (
                          <option key={lane.id} value={lane.id} disabled={integrationSources.includes(lane.id)}>
                            {lane.name}{integrationSources.includes(lane.id) ? " (source)" : ""}
                          </option>
                        ))}
                      </select>
                      <div style={{
                        marginTop: 6,
                        fontSize: 10,
                        fontFamily: "var(--font-sans)",
                        color: C.textMuted,
                        lineHeight: "14px",
                      }}>
                        Creates a new integration lane and prepares merge commits there. When an existing lane is selected, simulation includes conflicts against that lane&apos;s current HEAD.
                      </div>
                    </div>

                    {/* Simulate button */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button
                        disabled={integrationSources.length < 2 || simulating}
                        onClick={() => void handleSimulate()}
                        style={{
                          background: "transparent",
                          border: `1px solid ${C.accentBorder}`,
                          borderRadius: 0,
                          color: (integrationSources.length < 2 || simulating) ? C.textDisabled : C.accent,
                          fontFamily: "var(--font-sans)",
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "8px 14px",
                          cursor: (integrationSources.length < 2 || simulating) ? "not-allowed" : "pointer",
                          opacity: (integrationSources.length < 2 || simulating) ? 0.5 : 1,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {simulating && <CircleNotch size={12} className="animate-spin" />}
                        {simulating ? "SIMULATING..." : "PREVIEW INTEGRATION"}
                      </button>
                      {integrationSources.length < 2 && (
                        <span style={{
                          fontSize: 11,
                          fontFamily: "var(--font-sans)",
                          color: C.textDisabled,
                        }}>
                          Select at least 2 lanes
                        </span>
                      )}
                    </div>

                    {/* Simulation results */}
                    {proposal && (
                      <div style={{
                        background: C.bgInput,
                        border: `1px solid ${C.border}`,
                        borderRadius: 0,
                        padding: 16,
                      }}>
                        <div style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: 12,
                        }}>
                          <span style={{
                            ...labelStyle,
                            marginBottom: 0,
                          }}>MERGE PREVIEW</span>
                          <span style={{
                            fontSize: 10,
                            fontWeight: 700,
                            fontFamily: "var(--font-sans)",
                            textTransform: "uppercase" as const,
                            letterSpacing: "1px",
                            padding: "4px 8px",
                            borderRadius: 0,
                            color: outcomeColor(proposal.overallOutcome),
                            background: `${outcomeColor(proposal.overallOutcome)}18`,
                          }}>
                            {proposal.overallOutcome.toUpperCase()}
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {proposal.steps.map((s) => (
                            <div key={s.laneId} style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 12,
                              fontFamily: "var(--font-sans)",
                            }}>
                              <StepOutcome outcome={s.outcome} />
                              <span style={{ color: C.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.laneName}
                              </span>
                              <span style={{ fontSize: 11, color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>
                                +{s.diffStat.insertions} -{s.diffStat.deletions} ({s.diffStat.filesChanged} files)
                              </span>
                            </div>
                          ))}
                        </div>
                        {proposal.steps.some((s) => s.conflictingFiles.length > 0) && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{
                              fontSize: 10,
                              fontWeight: 700,
                              fontFamily: "var(--font-sans)",
                              textTransform: "uppercase" as const,
                              letterSpacing: "1px",
                              color: C.warning,
                              marginBottom: 6,
                            }}>
                              CONFLICTING FILES
                            </div>
                            {proposal.steps
                              .flatMap((s) => s.conflictingFiles.map((f) => ({ lane: s.laneName, path: f.path })))
                              .map((f, i) => (
                                <div key={i} style={{
                                  fontSize: 11,
                                  fontFamily: "var(--font-sans)",
                                  color: `${C.warning}99`,
                                  paddingLeft: 8,
                                  lineHeight: "18px",
                                }}>
                                  {f.path}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <span style={labelStyle}>INTEGRATION BRANCH NAME</span>
                      <input
                        type="text"
                        value={integrationName}
                        onChange={(e) => {
                          const val = e.target.value;
                          setIntegrationName(val);
                          const trimmed = val.trim();
                          if (trimmed.length === 0) {
                            setIntegrationBranchError(null);
                          } else if (INVALID_GIT_REF_RE.test(trimmed)) {
                            setIntegrationBranchError("Branch name contains invalid characters (spaces, ~, ^, :, ?, *, [, \\, or consecutive dots).");
                          } else if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
                            setIntegrationBranchError("Branch name must not start or end with \"/\".");
                          } else if (trimmed.endsWith(".lock") || trimmed.endsWith(".")) {
                            setIntegrationBranchError("Branch name must not end with \".lock\" or \".\".");
                          } else {
                            setIntegrationBranchError(null);
                          }
                        }}
                        style={{
                          ...inputStyle,
                          ...(integrationBranchError ? { borderColor: C.error } : {}),
                        }}
                        placeholder="integration/feature-bundle"
                        onFocus={(e) => { e.currentTarget.style.borderColor = integrationBranchError ? C.error : C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = integrationBranchError ? C.error : C.borderSubtle; }}
                      />
                      {integrationBranchError && (
                        <div style={{
                          fontSize: 11,
                          fontFamily: "var(--font-sans)",
                          color: C.error,
                          marginTop: 4,
                        }}>
                          {integrationBranchError}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ── Merge method (normal & queue only) ────────── */}
                {mode !== "integration" && (
                  <div>
                    <span style={labelStyle}>MERGE METHOD (ON LAND)</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {MERGE_METHODS.map((m) => {
                        const selected = mergeMethod === m.id;
                        return (
                          <button
                            key={m.id}
                            onClick={() => setMergeMethod(m.id)}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              padding: "10px 12px",
                              background: selected ? C.accentSubtleBg : "transparent",
                              border: selected
                                ? `1px solid ${C.accentBorder}`
                                : `1px solid ${C.border}`,
                              borderRadius: 0,
                              cursor: "pointer",
                              textAlign: "left",
                              outline: "none",
                              transition: "all 0.1s",
                            }}
                          >
                            <div style={{
                              marginTop: 2,
                              width: 14,
                              height: 14,
                              minWidth: 14,
                              border: `2px solid ${selected ? C.accent : C.textDisabled}`,
                              borderRadius: 0,
                              background: selected ? C.accent : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}>
                              {selected && (
                                <Check size={8} weight="bold" style={{ color: C.bgMain }} />
                              )}
                            </div>
                            <div>
                              <div style={{
                                fontFamily: "var(--font-sans)",
                                fontSize: 12,
                                fontWeight: 600,
                                color: C.textPrimary,
                              }}>
                                {m.label}
                              </div>
                              <div style={{
                                fontFamily: "var(--font-sans)",
                                fontSize: 11,
                                color: C.textMuted,
                                marginTop: 2,
                              }}>
                                {m.desc}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {execError && (
                  <div style={errorBannerStyle}>{execError}</div>
                )}
              </div>
            )}

            {/* ════════════════════════════════════════════════════ */}
            {/* STEP 2 — DETAILS                                    */}
            {/* ════════════════════════════════════════════════════ */}
            {numericStep === 2 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

                {mode === "normal" && (
                  <>
                    <div>
                      <span style={labelStyle}>PULL REQUEST TITLE</span>
                      <input
                        type="text"
                        value={normalTitle}
                        onChange={(e) => setNormalTitle(e.target.value)}
                        style={inputStyle}
                        placeholder="Auto-generated from lane name"
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
                    </div>

                    <div>
                      <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 8,
                      }}>
                        <span style={{ ...labelStyle, marginBottom: 0 }}>DESCRIPTION</span>
                        <button
                          disabled={!normalLaneId || drafting}
                          onClick={() => void handleDraftAI(normalLaneId)}
                          style={{
                            background: "transparent",
                            border: `1px solid ${C.accentBorder}`,
                            borderRadius: 0,
                            color: (!normalLaneId || drafting) ? C.textDisabled : C.accent,
                            fontFamily: "var(--font-sans)",
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "uppercase" as const,
                            letterSpacing: "1px",
                            padding: "6px 12px",
                            cursor: (!normalLaneId || drafting) ? "not-allowed" : "pointer",
                            opacity: (!normalLaneId || drafting) ? 0.5 : 1,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {drafting ? (
                            <CircleNotch size={12} className="animate-spin" />
                          ) : (
                            <Sparkle size={12} weight="fill" />
                          )}
                          {drafting ? "DRAFTING..." : "DRAFT DESCRIPTION"}
                        </button>
                      </div>
                      <textarea
                        value={normalBody}
                        onChange={(e) => setNormalBody(e.target.value)}
                        rows={6}
                        style={textareaStyle}
                        placeholder="PR description (markdown)..."
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
                    </div>

                    <label style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontFamily: "var(--font-sans)",
                      fontSize: 12,
                      color: C.textPrimary,
                      cursor: "pointer",
                    }}>
                      <input
                        type="checkbox"
                        checked={normalDraft}
                        onChange={(e) => setNormalDraft(e.target.checked)}
                        style={{ accentColor: C.accent }}
                      />
                      CREATE AS DRAFT
                    </label>
                    <LaneWarningPanel
                      items={selectedNormalWarnings}
                      loading={selectedNormalLoading}
                      rebaseLaneIds={selectedNormalRebaseLaneIds}
                      onOpenRebase={openRebaseTab}
                    />
                  </>
                )}

                {mode === "queue" && (
                  <>
                    <div style={{
                      background: C.bgInput,
                      border: `1px solid ${C.border}`,
                      borderRadius: 0,
                      padding: 16,
                    }}>
                      <span style={labelStyle}>QUEUE ORDER</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {queueLaneIds.map((laneId, idx) => {
                          const lane = lanes.find((l) => l.id === laneId);
                          return (
                            <div key={laneId} style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontFamily: "var(--font-sans)",
                              fontSize: 12,
                              color: C.textPrimary,
                            }}>
                              <span style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: C.accent,
                                minWidth: 20,
                              }}>
                                #{idx + 1}
                              </span>
                              <span style={{ flex: 1 }}>{lane?.name ?? laneId}</span>
                              <span style={{ fontSize: 11, color: C.textMuted }}>{lane?.branchRef}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ marginTop: 10, fontSize: 11, color: C.textMuted, fontFamily: MONO_FONT }}>
                        This order will be used exactly when ADE creates the queue PRs.
                      </div>
                    </div>

                    <label style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontFamily: "var(--font-sans)",
                      fontSize: 12,
                      color: C.textPrimary,
                      cursor: "pointer",
                    }}>
                      <input
                        type="checkbox"
                        checked={queueDraft}
                        onChange={(e) => setQueueDraft(e.target.checked)}
                        style={{ accentColor: C.accent }}
                      />
                      CREATE AS DRAFTS
                    </label>
                    <LaneWarningPanel
                      items={selectedQueueWarnings}
                      loading={selectedQueueLoading}
                      rebaseLaneIds={selectedQueueRebaseLaneIds}
                      onOpenRebase={openRebaseTab}
                    />
                  </>
                )}

                {mode === "integration" && (
                  <>
                    {/* Summary of what's being integrated */}
                    <div style={{
                      background: C.bgInput,
                      border: `1px solid ${C.border}`,
                      borderRadius: 0,
                      padding: 16,
                    }}>
                      <span style={labelStyle}>INTEGRATION SUMMARY</span>
                      <div style={{
                        fontSize: 12,
                        fontFamily: "var(--font-sans)",
                        color: C.textSecondary,
                        marginBottom: 8,
                      }}>
                        {integrationSources.length} lanes into <span style={{ color: C.accent }}>{integrationName || "integration/..."}</span>
                      </div>
                      {proposal && (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          fontFamily: "var(--font-sans)",
                          textTransform: "uppercase" as const,
                          letterSpacing: "1px",
                          padding: "4px 8px",
                          borderRadius: 0,
                          color: outcomeColor(proposal.overallOutcome),
                          background: `${outcomeColor(proposal.overallOutcome)}18`,
                        }}>
                          {proposal.overallOutcome.toUpperCase()}
                        </span>
                      )}
                    </div>

                    <div>
                      <span style={labelStyle}>PULL REQUEST TITLE</span>
                      <input
                        type="text"
                        value={integrationTitle}
                        onChange={(e) => setIntegrationTitle(e.target.value)}
                        style={inputStyle}
                        placeholder="Integration workflow"
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
                    </div>

                    <div>
                      <span style={labelStyle}>DESCRIPTION</span>
                      <textarea
                        value={integrationBody}
                        onChange={(e) => setIntegrationBody(e.target.value)}
                        rows={5}
                        style={textareaStyle}
                        placeholder="PR description (markdown)..."
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
                    </div>

                    <label style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontFamily: "var(--font-sans)",
                      fontSize: 12,
                      color: C.textPrimary,
                      cursor: "pointer",
                    }}>
                      <input
                        type="checkbox"
                        checked={integrationDraft}
                        onChange={(e) => setIntegrationDraft(e.target.checked)}
                        style={{ accentColor: C.accent }}
                      />
                      CREATE AS DRAFT
                    </label>
                    <LaneWarningPanel
                      items={selectedIntegrationWarnings}
                      loading={selectedIntegrationLoading}
                      rebaseLaneIds={selectedIntegrationRebaseLaneIds}
                      onOpenRebase={openRebaseTab}
                    />
                  </>
                )}

                {draftError && (
                  <div style={errorBannerStyle}>Draft failed: {draftError}</div>
                )}

                {execError && (
                  <div style={errorBannerStyle}>{execError}</div>
                )}

                {integrationProgress && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    color: C.accent,
                    padding: "8px 0",
                  }}>
                    <CircleNotch size={12} className="animate-spin" />
                    {integrationProgress}
                  </div>
                )}
              </div>
            )}

            {/* ════════════════════════════════════════════════════ */}
            {/* STEP 3 — REVIEW / EXECUTE                           */}
            {/* ════════════════════════════════════════════════════ */}
            {numericStep === 3 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Proposal saved (integration mode, no PRs created) */}
                {results && results.length === 0 && mode === "integration" && !execError && (
                  <div>
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 12,
                    }}>
                      <CheckCircle size={18} weight="fill" style={{ color: C.success }} />
                      <span style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: 16,
                        fontWeight: 700,
                        color: C.textPrimary,
                      }}>
                        Proposal Saved
                      </span>
                    </div>
                    <div style={{
                      background: C.bgInput,
                      border: `1px solid ${C.border}`,
                      padding: "12px 16px",
                      fontFamily: "var(--font-sans)",
                      fontSize: 12,
                      color: C.textSecondary,
                    }}>
                      Lifecycle: <span style={{ color: C.accent, fontWeight: 700 }}>Proposal</span> → <span style={{ color: C.accent, fontWeight: 700 }}>Integration lane</span> → <span style={{ color: C.accent, fontWeight: 700 }}>GitHub PR</span>.
                      {" "}
                      ADE has already prepared the integration lane{integrationName ? ` "${integrationName}"` : ""}. Continue in the <span style={{ color: C.accent, fontWeight: 700 }}>INTEGRATION</span> tab to review it and create the GitHub PR.
                    </div>
                  </div>
                )}

                {/* Created PRs */}
                {results && results.length > 0 && (
                  <div>
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 12,
                    }}>
                      {queueErrors.length > 0 ? (
                        <Warning size={18} weight="fill" style={{ color: C.warning }} />
                      ) : (
                        <CheckCircle size={18} weight="fill" style={{ color: C.success }} />
                      )}
                      <span style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: 16,
                        fontWeight: 700,
                        color: C.textPrimary,
                      }}>
                        {queueErrors.length > 0
                          ? `Created ${results.length} of ${results.length + queueErrors.length} PRs. ${queueErrors.length} failed.`
                          : `Created ${results.length} PR${results.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>
                    {queueErrors.length > 0 && (
                      <div style={{
                        ...errorBannerStyle,
                        marginBottom: 10,
                      }}>
                        {queueErrors.map((e) => {
                          const lane = lanes.find((l) => l.id === e.laneId);
                          return `${lane?.name ?? e.laneId}: ${e.error}`;
                        }).join("\n")}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {results.map((pr) => (
                        <div
                          key={pr.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            background: C.bgInput,
                            border: `1px solid ${C.border}`,
                            borderRadius: 0,
                            padding: "12px 16px",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{
                              fontFamily: "var(--font-sans)",
                              fontSize: 12,
                              fontWeight: 700,
                              color: C.accent,
                            }}>
                              #{pr.githubPrNumber}
                            </span>
                            <span style={{
                              fontFamily: "var(--font-sans)",
                              fontSize: 12,
                              color: C.textSecondary,
                            }}>
                              {pr.title}
                            </span>
                          </div>
                          <button
                            onClick={() => void window.ade.app.openExternal(pr.githubUrl)}
                            style={{
                              background: "transparent",
                              border: `1px solid ${C.accentBorder}`,
                              borderRadius: 0,
                              color: C.accent,
                              fontFamily: "var(--font-sans)",
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: "uppercase" as const,
                              letterSpacing: "1px",
                              padding: "4px 10px",
                              cursor: "pointer",
                            }}
                          >
                            VIEW
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Integration merge results */}
                {integrationResult && integrationResult.mergeResults.length > 0 && (
                  <div>
                    <span style={labelStyle}>MERGE RESULTS</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {integrationResult.mergeResults.map((mr) => {
                        const laneName = lanes.find((l) => l.id === mr.laneId)?.name ?? mr.laneId;
                        return (
                          <div key={mr.laneId} style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            fontFamily: "var(--font-sans)",
                            fontSize: 12,
                            padding: "6px 0",
                          }}>
                            {mr.success ? (
                              <CheckCircle size={14} weight="fill" style={{ color: C.success }} />
                            ) : (
                              <Warning size={14} weight="fill" style={{ color: C.error }} />
                            )}
                            <span style={{ color: C.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {laneName}
                            </span>
                            {mr.error && (
                              <span style={{
                                fontSize: 11,
                                color: C.error,
                                maxWidth: 200,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}>
                                {mr.error}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Error display */}
                {execError && (
                  <div style={errorBannerStyle}>{execError}</div>
                )}
              </div>
            )}
          </div>

          {/* ── Footer ──────────────────────────────────────────── */}
          <div style={{
            height: 72,
            minHeight: 72,
            background: C.bgHeader,
            borderTop: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
          }}>
            {/* Left side */}
            <div>
              {numericStep === 1 && (
                <Dialog.Close asChild>
                  <button
                    style={{
                      background: "transparent",
                      border: `1px solid ${C.borderSubtle}`,
                      borderRadius: 0,
                      color: C.textSecondary,
                      fontFamily: "var(--font-sans)",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase" as const,
                      letterSpacing: "1px",
                      padding: "10px 18px",
                      cursor: "pointer",
                    }}
                  >
                    CANCEL
                  </button>
                </Dialog.Close>
              )}
              {numericStep === 2 && (
                <button
                  onClick={goBackToStep1}
                  style={{
                    background: "transparent",
                    border: `1px solid ${C.borderSubtle}`,
                    borderRadius: 0,
                    color: C.textSecondary,
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase" as const,
                    letterSpacing: "1px",
                    padding: "10px 18px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <ArrowLeft size={12} weight="bold" />
                  BACK
                </button>
              )}
              {numericStep === 3 && (
                <div /> /* empty spacer */
              )}
            </div>

            {/* Right side */}
            <div>
              {numericStep === 1 && (
                <button
                  disabled={!canProceed}
                  onClick={goToStep2}
                  style={{
                    background: canProceed ? C.accent : C.textDisabled,
                    border: "none",
                    borderRadius: 0,
                    color: C.bgMain,
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase" as const,
                    letterSpacing: "1px",
                    padding: "10px 20px",
                    cursor: canProceed ? "pointer" : "not-allowed",
                    opacity: canProceed ? 1 : 0.5,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  NEXT STEP
                  <ArrowRight size={12} weight="bold" />
                </button>
              )}
              {numericStep === 2 && (
                <button
                  disabled={busy || !canProceed}
                  onClick={() => void handleCreate()}
                  style={{
                    background: (busy || !canProceed) ? C.textDisabled : C.accent,
                    border: "none",
                    borderRadius: 0,
                    color: C.bgMain,
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase" as const,
                    letterSpacing: "1px",
                    padding: "10px 20px",
                    cursor: (busy || !canProceed) ? "not-allowed" : "pointer",
                    opacity: (busy || !canProceed) ? 0.5 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {busy && <CircleNotch size={12} className="animate-spin" />}
                  {getCreateActionLabel(mode, busy)}
                </button>
              )}
              {numericStep === 3 && results && (
                <Dialog.Close asChild>
                  <button
                    onClick={() => onCreated?.()}
                    style={{
                      background: C.accent,
                      border: "none",
                      borderRadius: 0,
                      color: C.bgMain,
                      fontFamily: "var(--font-sans)",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase" as const,
                      letterSpacing: "1px",
                      padding: "10px 24px",
                      cursor: "pointer",
                    }}
                  >
                    DONE
                  </button>
                </Dialog.Close>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
