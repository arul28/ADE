import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitPullRequest, GitMerge, Stack as Layers, CheckCircle, Warning, CircleNotch, X, GitBranch, Sparkle, ArrowRight, ArrowLeft, Check } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import type {
  MergeMethod,
  PrSummary,
  IntegrationProposal,
  IntegrationProposalStep,
  CreateIntegrationPrResult,
} from "../../../shared/types";

import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

type CreateMode = "normal" | "queue" | "integration";
type WizardStep = "select-type" | "configure" | "execute";

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
  { id: "normal", label: "Normal PR", icon: GitPullRequest, desc: "Single lane creates one PR." },
  { id: "queue", label: "Queue PRs", icon: Layers, desc: "Multiple lanes targeting the same branch, landed sequentially." },
  { id: "integration", label: "Integration PR", icon: GitMerge, desc: "Merge multiple lanes into one integration branch, then open a PR." },
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

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "none" as const,
};

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
                fontFamily: "'JetBrains Mono', monospace",
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
                fontFamily: "'JetBrains Mono', monospace",
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

  const [, setStep] = React.useState<WizardStep>("select-type");
  const [mode, setMode] = React.useState<CreateMode>("normal");

  // Internal numeric step for stepper (1=BRANCH, 2=DETAILS, 3=REVIEW)
  const [numericStep, setNumericStep] = React.useState(1);

  // Shared
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");

  // Normal PR
  const [normalLaneId, setNormalLaneId] = React.useState<string>("");
  const [normalTitle, setNormalTitle] = React.useState("");
  const [normalDraft, setNormalDraft] = React.useState(false);

  // Queue PRs
  const [queueLaneIds, setQueueLaneIds] = React.useState<string[]>([]);
  const [queueDraft, setQueueDraft] = React.useState(false);

  // Body & AI draft
  const [normalBody, setNormalBody] = React.useState("");
  const [draftModel, setDraftModel] = React.useState("haiku");
  const [drafting, setDrafting] = React.useState(false);

  // Integration PR
  const [integrationSources, setIntegrationSources] = React.useState<string[]>([]);
  const [integrationName, setIntegrationName] = React.useState("");
  const [integrationTitle, setIntegrationTitle] = React.useState("");
  const [integrationBody, setIntegrationBody] = React.useState("");
  const [integrationDraft, setIntegrationDraft] = React.useState(false);
  const [proposal, setProposal] = React.useState<IntegrationProposal | null>(null);
  const [simulating, setSimulating] = React.useState(false);

  const handleDraftAI = async (laneId: string) => {
    setDrafting(true);
    try {
      const result = await window.ade.prs.draftDescription(laneId, draftModel);
      if (mode === "normal") {
        setNormalTitle(result.title);
        setNormalBody(result.body);
      }
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrafting(false);
    }
  };

  // Execute
  const [busy, setBusy] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<PrSummary[] | null>(null);
  const [integrationResult, setIntegrationResult] = React.useState<CreateIntegrationPrResult | null>(null);

  // Reset on close
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setStep("select-type");
      setMode("normal");
      setNumericStep(1);
      setMergeMethod("squash");
      setNormalLaneId("");
      setNormalTitle("");
      setNormalDraft(false);
      setQueueLaneIds([]);
      setQueueDraft(false);
      setBusy(false);
      setExecError(null);
      setResults(null);
      setNormalBody("");
      setDraftModel("haiku");
      setDrafting(false);
      setIntegrationSources([]);
      setIntegrationName("");
      setIntegrationTitle("");
      setIntegrationBody("");
      setIntegrationDraft(false);
      setProposal(null);
      setSimulating(false);
      setIntegrationResult(null);
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  const handleSimulate = async () => {
    if (integrationSources.length === 0) return;
    setSimulating(true);
    setExecError(null);
    setProposal(null);
    try {
      const baseBranch = primaryLane?.branchRef ?? "main";
      const result = await window.ade.prs.simulateIntegration({
        sourceLaneIds: integrationSources,
        baseBranch,
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
    try {
      if (mode === "normal") {
        const lane = lanes.find((l) => l.id === normalLaneId);
        const pr = await window.ade.prs.createFromLane({
          laneId: normalLaneId,
          title: normalTitle || lane?.name || "PR",
          body: normalBody,
          draft: normalDraft,
        });
        setResults([pr]);
      } else if (mode === "queue") {
        const baseBranch = primaryLane?.branchRef ?? "main";
        const result = await window.ade.prs.createQueue({
          laneIds: queueLaneIds,
          targetBranch: baseBranch,
          draft: queueDraft,
        });
        if (result.errors.length > 0) {
          setExecError(result.errors.map((e) => `${e.laneId}: ${e.error}`).join("\n"));
        }
        setResults(result.prs);
      } else if (mode === "integration") {
        if (!proposal) {
          setExecError("Run a simulation first to create a proposal.");
          setBusy(false);
          return;
        }
        await window.ade.prs.updateProposal({
          proposalId: proposal.proposalId,
          title: integrationTitle || "Integration PR",
          body: integrationBody,
          draft: integrationDraft,
          integrationLaneName: integrationName || `integration/${Date.now().toString(36)}`,
        });
        // No PR created — proposal saved for later commit from Integration tab
        setResults([]);
      }
      setStep("execute");
      setNumericStep(3);
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
      setStep("execute");
      setNumericStep(3);
    } finally {
      setBusy(false);
    }
  };

  const nonPrimaryLanes = React.useMemo(() => lanes.filter((l) => l.laneType !== "primary"), [lanes]);

  const toggleQueueLane = (laneId: string) => {
    setQueueLaneIds((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId]
    );
  };

  const toggleIntegrationSource = (laneId: string) => {
    setIntegrationSources((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId]
    );
    // Clear proposal when sources change
    setProposal(null);
  };

  const canCreateIntegration =
    integrationSources.length >= 2 &&
    !!proposal &&
    proposal.overallOutcome !== "blocked";

  /* Can user advance from step 1 to step 2? */
  const canAdvanceStep1 =
    (mode === "normal" && !!normalLaneId) ||
    (mode === "queue" && queueLaneIds.length > 0) ||
    (mode === "integration" && canCreateIntegration);

  /* Can user create from step 2? */
  const canCreateFromStep2 =
    (mode === "normal" && !!normalLaneId) ||
    (mode === "queue" && queueLaneIds.length > 0) ||
    (mode === "integration" && canCreateIntegration);

  const goToStep2 = () => {
    setNumericStep(2);
  };

  const goBackToStep1 = () => {
    setNumericStep(1);
  };

  /* ── selected lane info for comparison section ──────────────────── */
  const selectedNormalLane = React.useMemo(
    () => lanes.find((l) => l.id === normalLaneId) ?? null,
    [lanes, normalLaneId],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 14,
              fontWeight: 700,
              color: C.accent,
            }}>
              01
            </span>
            <Dialog.Title style={{
              fontFamily: "'Space Grotesk', sans-serif",
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
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: C.textMuted,
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
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
                            fontFamily: "'JetBrains Mono', monospace",
                            textTransform: "uppercase" as const,
                            letterSpacing: "1px",
                            color: selected ? C.textPrimary : C.textSecondary,
                          }}>
                            {m.label}
                          </span>
                          <span style={{
                            fontSize: 10,
                            fontFamily: "'JetBrains Mono', monospace",
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
                      <div style={{
                        ...inputStyle,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        color: C.textSecondary,
                        cursor: "default",
                      }}>
                        <GitBranch size={14} weight="bold" style={{ color: C.textMuted }} />
                        {primaryLane?.branchRef ?? "main"}
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
                                fontFamily: "'Space Grotesk', sans-serif",
                                fontSize: 20,
                                fontWeight: 700,
                                color: stat.color,
                              }}>
                                {stat.value}
                              </div>
                              <div style={{
                                fontSize: 9,
                                fontWeight: 700,
                                fontFamily: "'JetBrains Mono', monospace",
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
                      </div>
                    )}
                  </>
                )}

                {/* ── Queue mode: Lane selection ─────────────────── */}
                {mode === "queue" && (
                  <div>
                    <span style={labelStyle}>SELECT LANES (IN QUEUE ORDER)</span>
                    <div style={{
                      maxHeight: 200,
                      overflowY: "auto",
                      background: C.bgInput,
                      border: `1px solid ${C.border}`,
                      borderRadius: 0,
                      padding: 8,
                    }}>
                      {nonPrimaryLanes.map((lane) => {
                        const checked = queueLaneIds.includes(lane.id);
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
                              onChange={() => toggleQueueLane(lane.id)}
                              style={{ accentColor: C.accent }}
                            />
                            <span style={{
                              fontFamily: "'JetBrains Mono', monospace",
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
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 11,
                              color: C.textMuted,
                            }}>
                              {lane.branchRef}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {queueLaneIds.length > 0 && (
                      <div style={{
                        marginTop: 8,
                        fontSize: 11,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: C.textSecondary,
                      }}>
                        {queueLaneIds.length} lane{queueLaneIds.length !== 1 ? "s" : ""} selected
                      </div>
                    )}
                  </div>
                )}

                {/* ── Integration mode: Source lanes + simulation ─── */}
                {mode === "integration" && (
                  <>
                    <div>
                      <span style={labelStyle}>SOURCE LANES TO INTEGRATE (SELECT 2+)</span>
                      <div style={{
                        maxHeight: 200,
                        overflowY: "auto",
                        background: C.bgInput,
                        border: `1px solid ${C.border}`,
                        borderRadius: 0,
                        padding: 8,
                      }}>
                        {nonPrimaryLanes.map((lane) => {
                          const checked = integrationSources.includes(lane.id);
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
                                onChange={() => toggleIntegrationSource(lane.id)}
                                style={{ accentColor: C.accent }}
                              />
                              <span style={{
                                fontFamily: "'JetBrains Mono', monospace",
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
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 11,
                                color: C.textMuted,
                              }}>
                                {lane.branchRef}
                              </span>
                            </label>
                          );
                        })}
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
                          fontFamily: "'JetBrains Mono', monospace",
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
                          fontFamily: "'JetBrains Mono', monospace",
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
                            fontFamily: "'JetBrains Mono', monospace",
                            textTransform: "uppercase" as const,
                            letterSpacing: "1px",
                            padding: "4px 8px",
                            borderRadius: 0,
                            color: proposal.overallOutcome === "clean"
                              ? C.success
                              : proposal.overallOutcome === "conflict"
                                ? C.warning
                                : C.error,
                            background: proposal.overallOutcome === "clean"
                              ? `${C.success}18`
                              : proposal.overallOutcome === "conflict"
                                ? `${C.warning}18`
                                : `${C.error}18`,
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
                              fontFamily: "'JetBrains Mono', monospace",
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
                              fontFamily: "'JetBrains Mono', monospace",
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
                                  fontFamily: "'JetBrains Mono', monospace",
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
                        onChange={(e) => setIntegrationName(e.target.value)}
                        style={inputStyle}
                        placeholder="integration/feature-bundle"
                        onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = C.borderSubtle; }}
                      />
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
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 12,
                                fontWeight: 600,
                                color: C.textPrimary,
                              }}>
                                {m.label}
                              </div>
                              <div style={{
                                fontFamily: "'JetBrains Mono', monospace",
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
                  <div style={{
                    background: `${C.error}0D`,
                    border: `1px solid ${C.error}33`,
                    borderRadius: 0,
                    padding: "10px 14px",
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: C.error,
                    whiteSpace: "pre-wrap",
                  }}>
                    {execError}
                  </div>
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
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <select
                            value={draftModel}
                            onChange={(e) => setDraftModel(e.target.value)}
                            style={{
                              background: C.bgInput,
                              border: `1px solid ${C.borderSubtle}`,
                              color: C.textSecondary,
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 10,
                              padding: "4px 8px",
                              borderRadius: 0,
                              outline: "none",
                              cursor: "pointer",
                              textTransform: "uppercase" as const,
                              letterSpacing: "1px",
                            }}
                          >
                            <option value="haiku">HAIKU</option>
                            <option value="sonnet">SONNET</option>
                            <option value="opus">OPUS</option>
                          </select>
                          <button
                            disabled={!normalLaneId || drafting}
                            onClick={() => void handleDraftAI(normalLaneId)}
                            style={{
                              background: "transparent",
                              border: `1px solid ${C.accentBorder}`,
                              borderRadius: 0,
                              color: (!normalLaneId || drafting) ? C.textDisabled : C.accent,
                              fontFamily: "'JetBrains Mono', monospace",
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
                            {drafting ? "DRAFTING..." : "GENERATE WITH AI"}
                          </button>
                        </div>
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
                      fontFamily: "'JetBrains Mono', monospace",
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
                      <span style={labelStyle}>QUEUED LANES</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {queueLaneIds.map((laneId, idx) => {
                          const lane = lanes.find((l) => l.id === laneId);
                          return (
                            <div key={laneId} style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontFamily: "'JetBrains Mono', monospace",
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
                    </div>

                    <label style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontFamily: "'JetBrains Mono', monospace",
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
                        fontFamily: "'JetBrains Mono', monospace",
                        color: C.textSecondary,
                        marginBottom: 8,
                      }}>
                        {integrationSources.length} lanes into <span style={{ color: C.accent }}>{integrationName || "integration/..."}</span>
                      </div>
                      {proposal && (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          fontFamily: "'JetBrains Mono', monospace",
                          textTransform: "uppercase" as const,
                          letterSpacing: "1px",
                          padding: "4px 8px",
                          borderRadius: 0,
                          color: proposal.overallOutcome === "clean"
                            ? C.success
                            : proposal.overallOutcome === "conflict"
                              ? C.warning
                              : C.error,
                          background: proposal.overallOutcome === "clean"
                            ? `${C.success}18`
                            : proposal.overallOutcome === "conflict"
                              ? `${C.warning}18`
                              : `${C.error}18`,
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
                        placeholder="Integration PR"
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
                      fontFamily: "'JetBrains Mono', monospace",
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
                  </>
                )}

                {execError && (
                  <div style={{
                    background: `${C.error}0D`,
                    border: `1px solid ${C.error}33`,
                    borderRadius: 0,
                    padding: "10px 14px",
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: C.error,
                    whiteSpace: "pre-wrap",
                  }}>
                    {execError}
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
                        fontFamily: "'Space Grotesk', sans-serif",
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
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: C.textSecondary,
                    }}>
                      Go to the <span style={{ color: C.accent, fontWeight: 700 }}>INTEGRATION</span> tab to review and create the PR on GitHub.
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
                      <CheckCircle size={18} weight="fill" style={{ color: C.success }} />
                      <span style={{
                        fontFamily: "'Space Grotesk', sans-serif",
                        fontSize: 16,
                        fontWeight: 700,
                        color: C.textPrimary,
                      }}>
                        Created {results.length} PR{results.length !== 1 ? "s" : ""}
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
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 12,
                              fontWeight: 700,
                              color: C.accent,
                            }}>
                              #{pr.githubPrNumber}
                            </span>
                            <span style={{
                              fontFamily: "'JetBrains Mono', monospace",
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
                              fontFamily: "'JetBrains Mono', monospace",
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
                            fontFamily: "'JetBrains Mono', monospace",
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
                  <div style={{
                    background: `${C.error}0D`,
                    border: `1px solid ${C.error}33`,
                    borderRadius: 0,
                    padding: "12px 16px",
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: C.error,
                    whiteSpace: "pre-wrap",
                  }}>
                    {execError}
                  </div>
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
                      fontFamily: "'JetBrains Mono', monospace",
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
                    fontFamily: "'JetBrains Mono', monospace",
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
                  disabled={!canAdvanceStep1}
                  onClick={goToStep2}
                  style={{
                    background: canAdvanceStep1 ? C.accent : C.textDisabled,
                    border: "none",
                    borderRadius: 0,
                    color: C.bgMain,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase" as const,
                    letterSpacing: "1px",
                    padding: "10px 20px",
                    cursor: canAdvanceStep1 ? "pointer" : "not-allowed",
                    opacity: canAdvanceStep1 ? 1 : 0.5,
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
                  disabled={busy || !canCreateFromStep2}
                  onClick={() => void handleCreate()}
                  style={{
                    background: (busy || !canCreateFromStep2) ? C.textDisabled : C.accent,
                    border: "none",
                    borderRadius: 0,
                    color: C.bgMain,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase" as const,
                    letterSpacing: "1px",
                    padding: "10px 20px",
                    cursor: (busy || !canCreateFromStep2) ? "not-allowed" : "pointer",
                    opacity: (busy || !canCreateFromStep2) ? 0.5 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {busy && <CircleNotch size={12} className="animate-spin" />}
                  {busy ? (mode === "integration" ? "SAVING..." : "CREATING...") : mode === "integration" ? "SAVE PROPOSAL" : "CREATE PR"}
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
                      fontFamily: "'JetBrains Mono', monospace",
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
