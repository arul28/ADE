import React from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { CheckCircle, Warning, CircleNotch, X, ArrowRight, ArrowLeft, Check } from "@phosphor-icons/react";
import { BranchIcon } from "../ui/vcsIcons";
import { useAppStore } from "../../state/appStore";
import type {
  MergeMethod,
  PrSummary,
  GitUpstreamSyncStatus,
  GitBranchSummary,
} from "../../../shared/types";
import {
  buildLinearPrReference,
  ensureLinearPrReference,
} from "../../../shared/linearMagicWords";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { isDirtyWorktreeErrorMessage, stripDirtyWorktreePrefix } from "./shared/dirtyWorktree";
import { confirmDialog } from "../ui/dialog/confirm";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice/Banner";
import { branchNameFromRef, describePrTargetDiff, resolveLaneBaseBranch } from "./shared/laneBranchTargets";
import { describeLanePrIssues } from "./shared/lanePrWarnings";

export type CreatePrModalInitialValues = {
  sourceLaneId?: string | null;
  target?: "primary" | null;
};

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

function CreatePrErrorBanner({ message }: { message: string }) {
  return (
    <Banner
      model={{
        id: "create-pr-error",
        tone: "error",
        ariaLabel: message,
        title: <span style={{ display: "block", maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap" }}>{message}</span>,
      }}
      layout="inline"
    />
  );
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
                  ? `color-mix(in srgb, ${C.success} 9%, transparent)`
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
    if (
      !isDirtyWorktreeErrorMessage(message)
      || !(await confirmDialog({ title: args.confirmMessage, message: stripDirtyWorktreePrefix(message), confirmLabel: "Continue", tone: "warning" }))
    ) {
      throw error;
    }
    return await args.run(true);
  }
}

function LaneWarningPanel({
  items,
  loading,
}: {
  items: LaneWarningSummary[];
  loading: boolean;
}) {
  if (!items.length && !loading) return null;
  return (
    <Banner
      layout="inline"
      style={{ marginTop: 12 }}
      model={{
        id: "create-pr-lane-readiness",
        tone: "warning",
        icon: <Warning size={14} weight="fill" />,
        title: "Check Before Creating PR",
        busy: loading,
        extra: (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
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
          </div>
        ),
      }}
    />
  );
}

/* ── main component ────────────────────────────────────────────────── */

export function CreatePrModal({
  open,
  onOpenChange,
  onCreated,
  initialValues = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: PrSummary[]) => void | Promise<void>;
  initialValues?: CreatePrModalInitialValues | null;
}) {
  const lanes = useAppStore((s) => s.lanes);
  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  // Internal numeric step for stepper (1=BRANCH, 2=DETAILS, 3=REVIEW)
  const [numericStep, setNumericStep] = React.useState(1);

  // Shared
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");

  // Normal PR
  const [normalLaneId, setNormalLaneId] = React.useState<string>("");
  const [normalTitle, setNormalTitle] = React.useState("");
  const [normalDraft, setNormalDraft] = React.useState(false);
  const [normalBaseBranch, setNormalBaseBranch] = React.useState("");
  const [normalCloseLinearIssueOnMerge, setNormalCloseLinearIssueOnMerge] = React.useState(true);
  const normalBaseBranchDefaultRef = React.useRef("");
  const normalTitleDefaultRef = React.useRef("");
  const normalLinearBodyDefaultRef = React.useRef("");

  // Body
  const [normalBody, setNormalBody] = React.useState("");

  const [laneSyncStatusById, setLaneSyncStatusById] = React.useState<Record<string, GitUpstreamSyncStatus | null>>({});
  const [laneSyncLoadingById, setLaneSyncLoadingById] = React.useState<Record<string, boolean>>({});
  const [knownPrs, setKnownPrs] = React.useState<PrSummary[]>([]);

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
  }, [open, primaryLane]);

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

  // Execute
  const [busy, setBusy] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<PrSummary[] | null>(null);
  // Reset on close
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setNumericStep(1);
      setMergeMethod("squash");
      setNormalLaneId("");
      setNormalBaseBranch("");
      normalBaseBranchDefaultRef.current = "";
      setNormalTitle("");
      setNormalDraft(false);
      setNormalCloseLinearIssueOnMerge(true);
      normalTitleDefaultRef.current = "";
      normalLinearBodyDefaultRef.current = "";
      setBusy(false);
      setExecError(null);
      setResults(null);
      setNormalBody("");
      setAvailableBranches([]);
      setBranchLoadError(null);
      setKnownPrs([]);
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.ade.prs.listAll()
      .then((prs) => {
        if (!cancelled) setKnownPrs(prs);
      })
      .catch((err: unknown) => {
        console.warn("[CreatePrModal] listAll PRs failed", err);
        if (!cancelled) setKnownPrs([]);
      });
    return () => {
      cancelled = true;
    };
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
    window.ade.git.getSyncStatuses({ laneIds })
      .then((statuses) => {
        if (!cancelled) setLaneSyncStatusById(statuses);
      })
      .catch((err: unknown) => {
        console.warn("[CreatePrModal] getSyncStatuses failed", err);
        if (!cancelled) setLaneSyncStatusById({});
      })
      .finally(() => {
        if (cancelled) return;
        setLaneSyncLoadingById(Object.fromEntries(laneIds.map((laneId) => [laneId, false])));
      });
    return () => {
      cancelled = true;
    };
  }, [open, lanes]);

  const selectedNormalLane = React.useMemo(
    () => lanes.find((lane) => lane.id === normalLaneId) ?? null,
    [lanes, normalLaneId],
  );
  const selectedNormalLinearIssue = selectedNormalLane?.linearIssue ?? null;
  const normalTargetLabel = React.useMemo(() => {
    const targetBranch = branchNameFromRef(normalBaseBranch.trim() || primaryLane?.branchRef || "main");
    const targetLane = lanes.find((lane) => branchNameFromRef(lane.branchRef) === targetBranch);
    return targetLane?.name ?? (targetBranch || "target");
  }, [lanes, normalBaseBranch, primaryLane?.branchRef]);
  const normalDefaultTitle = React.useMemo(() => {
    if (!selectedNormalLane) return "";
    return `${selectedNormalLane.name} -> ${normalTargetLabel}`;
  }, [normalTargetLabel, selectedNormalLane]);

  React.useEffect(() => {
    if (!open) return;
    if (!selectedNormalLinearIssue) {
      // Lane no longer has a linked Linear issue — clear any auto-generated
      // body fragments and reset the close-on-merge toggle so stale
      // Linear-flavored values don't follow the user to a non-Linear lane.
      const previousAutoBody = normalLinearBodyDefaultRef.current;
      setNormalBody((current) =>
        previousAutoBody && current.trim() === previousAutoBody.trim() ? "" : current,
      );
      setNormalCloseLinearIssueOnMerge(true);
      normalLinearBodyDefaultRef.current = "";
      return;
    }

    const nextBody = `${buildLinearPrReference(selectedNormalLinearIssue, normalCloseLinearIssueOnMerge)}\n`;
    setNormalBody((current) => {
      const previousAutoBody = normalLinearBodyDefaultRef.current;
      if (!current.trim() || (previousAutoBody && current === previousAutoBody)) {
        normalLinearBodyDefaultRef.current = nextBody;
        return nextBody;
      }
      normalLinearBodyDefaultRef.current = nextBody;
      return ensureLinearPrReference(current, selectedNormalLinearIssue, normalCloseLinearIssueOnMerge, { preserveExisting: false });
    });
  }, [open, normalCloseLinearIssueOnMerge, selectedNormalLinearIssue]);

  React.useEffect(() => {
    if (!open || !normalDefaultTitle) return;
    setNormalTitle((current) => {
      const previousDefault = normalTitleDefaultRef.current;
      if (!current.trim() || (previousDefault && current === previousDefault)) {
        normalTitleDefaultRef.current = normalDefaultTitle;
        return normalDefaultTitle;
      }
      normalTitleDefaultRef.current = normalDefaultTitle;
      return current;
    });
  }, [normalDefaultTitle, open]);

  React.useEffect(() => {
    if (!open) return;
    if (!selectedNormalLane) {
      normalBaseBranchDefaultRef.current = "";
      setNormalBaseBranch("");
      return;
    }
    // The lane's open PR base, else its base (the project's default branch).
    const nextDefault = resolveLaneBaseBranch({
      lane: selectedNormalLane,
      primaryBranchRef: primaryLane?.branchRef ?? null,
      pullRequests: knownPrs,
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
  }, [knownPrs, lanes, open, primaryLane?.branchRef, selectedNormalLane]);

  const appliedInitialValuesKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open) {
      appliedInitialValuesKeyRef.current = null;
      return;
    }

    const sourceLaneId = initialValues?.sourceLaneId?.trim() ?? "";
    const target = initialValues?.target ?? null;
    const key = `${sourceLaneId}:${target ?? ""}`;
    if (!sourceLaneId && !target) return;
    if (appliedInitialValuesKeyRef.current === key) return;

    const sourceLane = sourceLaneId
      ? lanes.find((lane) => lane.id === sourceLaneId && lane.laneType !== "primary") ?? null
      : null;
    if (sourceLaneId && !sourceLane && lanes.length === 0) return;
    appliedInitialValuesKeyRef.current = key;

    setNumericStep(1);
    setExecError(null);
    setResults(null);

    if (sourceLane) {
      setNormalLaneId(sourceLane.id);
    }
    if (target === "primary") {
      normalBaseBranchDefaultRef.current = "";
      setNormalBaseBranch(branchNameFromRef(primaryLane?.branchRef ?? "main") || "main");
    }
  }, [initialValues, lanes, open, primaryLane?.branchRef]);

  const handleCreate = async () => {
    setBusy(true);
    setExecError(null);
    try {
      const lane = lanes.find((l) => l.id === normalLaneId);
      const linearIssue = lane?.linearIssue ?? null;
      const title = normalTitle.trim() || normalDefaultTitle || lane?.name || "PR";
      const body = linearIssue
        ? ensureLinearPrReference(normalBody, linearIssue, normalCloseLinearIssueOnMerge, { preserveExisting: false })
        : normalBody;
      const pr = await runWithDirtyWorktreeConfirmation({
        confirmMessage: "Continue and create the PR anyway?",
        run: async (allowDirtyWorktree) => await window.ade.prs.createFromLane({
          laneId: normalLaneId,
          title,
          body,
          draft: normalDraft,
          ...(linearIssue ? { closeLinearIssueOnMerge: normalCloseLinearIssueOnMerge } : {}),
          ...(normalBaseBranch.trim() ? { baseBranch: normalBaseBranch.trim() } : {}),
          ...(allowDirtyWorktree ? { allowDirtyWorktree: true } : {})
        })
      });
      setResults([pr]);
      await onCreated?.([pr]);
      setNumericStep(3);
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = rawMsg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      setExecError(msg);
      // Stay on current step so user can see the error and retry
    } finally {
      setBusy(false);
    }
  };

  const nonPrimaryLanes = React.useMemo(() => lanes.filter((l) => l.laneType !== "primary"), [lanes]);

  /* Can user advance to step 2 or submit from step 2? Same readiness check. */
  const canProceed = !!normalLaneId;

  const goToStep2 = () => {
    setExecError(null);
    setNumericStep(2);
  };

  const goBackToStep1 = () => {
    setExecError(null);
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
      targetBranch: normalBaseBranch,
      primaryBranchRef: primaryLane?.branchRef ?? null,
      pullRequests: knownPrs,
    });
    const messages = [
      ...baseMessages,
      ...(targetDiffMessage ? [targetDiffMessage] : []),
    ];
    if (!messages.length) return [];
    return [{ laneId: selectedNormalLane.id, laneName: selectedNormalLane.name, messages }];
  }, [knownPrs, laneWarningItemsById, normalBaseBranch, primaryLane?.branchRef, selectedNormalLane]);
  const selectedNormalLoading = Boolean(normalLaneId) && laneSyncLoadingById[normalLaneId] === true;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && busy) return; onOpenChange(next); }}
      title="Create pull request"
      description={
        numericStep === 1 ? "Configure branch"
          : numericStep === 2 ? "Enter PR details"
            : numericStep === 3 ? "Review results"
              : undefined
      }
      hideHeader
      hideClose
      width={560}
      maxHeight="84vh"
      dismissible={!busy}
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      panelStyle={{
        // Pinned near the top, not centered: the wizard changes height between
        // steps, and a centered panel would jump on every step.
        margin: "8vh auto auto",
        borderRadius: 0,
        background: C.bgCard,
        border: `1px solid ${C.border}`,
      }}
    >
        <div
          data-tour="prs.createModal"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
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
            <span aria-hidden="true" style={{
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              fontWeight: 700,
              color: C.textPrimary,
              margin: 0,
              flex: 1,
            }}>
              CREATE PULL REQUEST
            </span>
            <RadixDialog.Close asChild>
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
            </RadixDialog.Close>
          </div>

          {/* ── Stepper ─────────────────────────────────────────── */}
          <Stepper currentStep={numericStep} />

          {branchLoadError ? (
            <Banner
              model={{
                id: "create-pr-branch-load-error",
                tone: "error",
                title: `Could not load branch list: ${branchLoadError}`,
              }}
              layout="inline"
              style={{ margin: "8px 24px" }}
            />
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

                {/* ── Source / Target branch ─────────── */}
                    <div>
                      <span style={labelStyle}>SOURCE BRANCH</span>
                      <div style={{ position: "relative" }}>
                        <BranchIcon
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
                          data-tour="prs.createModal.source"
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
                        <BranchIcon
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
                          data-tour="prs.createModal.base"
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
                        />
                      </div>
                    )}
                {/* ── Merge method ─────────────── */}
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

                {execError ? <CreatePrErrorBanner message={execError} /> : null}
              </div>
            )}

            {/* ════════════════════════════════════════════════════ */}
            {/* STEP 2 — DETAILS                                    */}
            {/* ════════════════════════════════════════════════════ */}
            {numericStep === 2 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    <div>
                      <span style={labelStyle}>PULL REQUEST TITLE</span>
                      <input
                        type="text"
                        value={normalTitle}
                        onChange={(e) => setNormalTitle(e.target.value)}
                        style={inputStyle}
                        placeholder={normalDefaultTitle || "Source lane -> target"}
                        data-tour="prs.createModal.title"
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
                    </div>

                    <div>
                      <span style={labelStyle}>DESCRIPTION</span>
                      <textarea
                        value={normalBody}
                        onChange={(e) => setNormalBody(e.target.value)}
                        rows={6}
                        style={textareaStyle}
                        placeholder="PR description (markdown)..."
                        data-tour="prs.createModal.body"
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
                    </div>

                    {selectedNormalLinearIssue ? (
                      <div
                        style={{
                          border: `1px solid ${C.accentBorder}`,
                          background: C.accentSubtleBg,
                          padding: "10px 12px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: 11,
                              fontWeight: 700,
                              color: C.accent,
                            }}
                          >
                            {selectedNormalLinearIssue.identifier}
                          </span>
                          <span
                            style={{
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontFamily: "var(--font-sans)",
                              fontSize: 12,
                              color: C.textPrimary,
                            }}
                          >
                            {selectedNormalLinearIssue.title}
                          </span>
                        </div>
                        <label
                          style={{
                            display: "grid",
                            gridTemplateColumns: "auto minmax(0,1fr)",
                            alignItems: "start",
                            gap: "2px 8px",
                            fontFamily: "var(--font-sans)",
                            fontSize: 12,
                            color: C.textSecondary,
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={normalCloseLinearIssueOnMerge}
                            onChange={(e) => setNormalCloseLinearIssueOnMerge(e.target.checked)}
                            style={{ accentColor: C.accent }}
                          />
                          <span style={{ fontWeight: 700, color: C.textPrimary }}>
                            Close Linear issue when this PR merges
                          </span>
                          <span style={{ gridColumn: "2", fontSize: 11, color: C.textMuted, lineHeight: "15px" }}>
                            Off links the PR only. On changes the PR body from Refs to Fixes so Linear can complete the issue on merge.
                          </span>
                        </label>
                        <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: C.textMuted }}>
                          PR body will include {buildLinearPrReference(selectedNormalLinearIssue, normalCloseLinearIssueOnMerge)} so Linear links the PR.
                        </div>
                      </div>
                    ) : null}

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
                    />
                {execError ? <CreatePrErrorBanner message={execError} /> : null}

              </div>
            )}

            {/* ════════════════════════════════════════════════════ */}
            {/* STEP 3 — REVIEW / EXECUTE                           */}
            {/* ════════════════════════════════════════════════════ */}
            {numericStep === 3 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Created PRs */}
                {results && results.length > 0 && (
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
                        {`Created ${results.length} PR${results.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>
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

                {/* Error display */}
                {execError ? <CreatePrErrorBanner message={execError} /> : null}
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
                <RadixDialog.Close asChild>
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
                </RadixDialog.Close>
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
                  data-tour="prs.createModal.next"
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
                  data-tour="prs.createModal.submit"
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
                  {busy ? "CREATING..." : "CREATE PR"}
                </button>
              )}
              {numericStep === 3 && results && (
                <RadixDialog.Close asChild>
                  <button
                    onClick={() => onCreated?.(results)}
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
                </RadixDialog.Close>
              )}
            </div>
          </div>
        </div>
    </Dialog>
  );
}
