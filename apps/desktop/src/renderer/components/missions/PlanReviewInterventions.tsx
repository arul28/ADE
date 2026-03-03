import React, { useCallback, useState } from "react";
import { CheckCircle, Question, ArrowRight, X } from "@phosphor-icons/react";
import type { MissionDetail, MissionIntervention } from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  primaryButton,
  outlineButton,
} from "../lanes/laneDesignTokens";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const PLANNER_CLARIFY_SOURCE = "planner_clarifying_question";

type PlannerClarifyMeta = {
  source: typeof PLANNER_CLARIFY_SOURCE;
  questionIndex: number;
  question: string;
  context?: string;
  defaultAssumption?: string;
  impact?: string;
};

function isClarifyMeta(m: Record<string, unknown> | null): m is PlannerClarifyMeta {
  if (!m) return false;
  return m.source === PLANNER_CLARIFY_SOURCE && Number.isFinite(Number(m.questionIndex));
}

function toClarifyMeta(metadata: Record<string, unknown> | null): PlannerClarifyMeta | null {
  return isClarifyMeta(metadata) ? metadata : null;
}

type QuestionState =
  | { kind: "pending"; answer: string }
  | { kind: "submitting" }
  | { kind: "answered"; answer: string; source: "user" | "default_assumption" }
  | { kind: "error"; answer: string; errorMsg: string };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type PlanReviewInterventionsProps = {
  mission: MissionDetail;
  onAllResolved: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlanReviewInterventions({ mission, onAllResolved }: PlanReviewInterventionsProps) {
  // Filter to open manual_input interventions with planner clarify metadata,
  // sorted by questionIndex.
  const clarifyInterventions = React.useMemo(() => {
    return mission.interventions
      .filter(
        (iv) =>
          iv.interventionType === "manual_input" &&
          iv.status === "open" &&
          isClarifyMeta(iv.metadata)
      )
      .sort((a, b) => {
        const ma = toClarifyMeta(a.metadata);
        const mb = toClarifyMeta(b.metadata);
        return (ma?.questionIndex ?? 0) - (mb?.questionIndex ?? 0);
      });
  }, [mission.interventions]);

  // Per-intervention answer state keyed by intervention id.
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>(() => {
    const initial: Record<string, QuestionState> = {};
    for (const iv of clarifyInterventions) {
      initial[iv.id] = { kind: "pending", answer: "" };
    }
    return initial;
  });

  const [proceedBusy, setProceedBusy] = useState(false);

  // Sync state when interventions list changes (e.g. new ones arrive, or some disappear).
  React.useEffect(() => {
    setQuestionStates((prev) => {
      const next = { ...prev };
      for (const iv of clarifyInterventions) {
        if (!next[iv.id]) {
          next[iv.id] = { kind: "pending", answer: "" };
        }
      }
      return next;
    });
  }, [clarifyInterventions]);

  const setAnswer = useCallback((id: string, answer: string) => {
    setQuestionStates((prev) => {
      const current = prev[id];
      if (!current || current.kind === "submitting" || current.kind === "answered") return prev;
      const base: QuestionState =
        current.kind === "error"
          ? { kind: "pending", answer }
          : { kind: "pending", answer };
      return { ...prev, [id]: base };
    });
  }, []);

  const submitAnswer = useCallback(async (intervention: MissionIntervention, useDefault: boolean) => {
    const state = questionStates[intervention.id];
    if (!state || state.kind === "submitting" || state.kind === "answered") return;

    const userAnswer = state.kind === "pending" || state.kind === "error" ? state.answer : "";

    setQuestionStates((prev) => ({ ...prev, [intervention.id]: { kind: "submitting" } }));

    try {
      if (useDefault) {
        await window.ade.missions.resolveIntervention({
          missionId: mission.id,
          interventionId: intervention.id,
          status: "dismissed",
          note: null,
        });
        setQuestionStates((prev) => ({
          ...prev,
          [intervention.id]: {
            kind: "answered",
            answer: toClarifyMeta(intervention.metadata)?.defaultAssumption ?? "",
            source: "default_assumption",
          },
        }));
      } else {
        await window.ade.missions.resolveIntervention({
          missionId: mission.id,
          interventionId: intervention.id,
          status: "resolved",
          note: userAnswer.trim() || null,
        });
        setQuestionStates((prev) => ({
          ...prev,
          [intervention.id]: {
            kind: "answered",
            answer: userAnswer.trim() || "(no answer provided)",
            source: "user",
          },
        }));
      }
    } catch (err) {
      setQuestionStates((prev) => ({
        ...prev,
        [intervention.id]: {
          kind: "error",
          answer: userAnswer,
          errorMsg: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, [questionStates, mission.id]);

  const allAnswered = clarifyInterventions.every(
    (iv) => questionStates[iv.id]?.kind === "answered"
  );

  const handleProceed = useCallback(async () => {
    setProceedBusy(true);
    try {
      onAllResolved();
    } finally {
      setProceedBusy(false);
    }
  }, [onAllResolved]);

  if (clarifyInterventions.length === 0) return null;

  const answeredCount = clarifyInterventions.filter(
    (iv) => questionStates[iv.id]?.kind === "answered"
  ).length;

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.accentBorder}`,
        margin: "12px 16px",
      }}
    >
      {/* ── Panel header ── */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-3"
        style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.accentSubtle }}
      >
        <div className="flex items-center gap-2">
          <Question weight="bold" className="h-4 w-4 shrink-0" style={{ color: COLORS.accent }} />
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: COLORS.accent,
            }}
          >
            Planner Clarification Required
          </span>
        </div>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.textMuted,
          }}
        >
          {answeredCount}/{clarifyInterventions.length} answered
        </span>
      </div>

      {/* ── Explanation ── */}
      <div className="px-4 pt-3 pb-2">
        <p style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
          The mission planner has clarifying questions before generating the execution plan.
          Answer each question below, or use the default assumption to skip.
          Once all questions are addressed, you can approve the plan to proceed.
        </p>
      </div>

      {/* ── Questions ── */}
      <div className="px-4 pb-4 space-y-4">
        {clarifyInterventions.map((intervention, idx) => {
          const meta = toClarifyMeta(intervention.metadata);
          if (!meta) return null;
          const state = questionStates[intervention.id] ?? { kind: "pending", answer: "" };

          return (
            <QuestionCard
              key={intervention.id}
              index={idx}
              total={clarifyInterventions.length}
              meta={meta}
              state={state}
              onChangeAnswer={(answer) => setAnswer(intervention.id, answer)}
              onSubmit={(useDefault) => void submitAnswer(intervention, useDefault)}
            />
          );
        })}
      </div>

      {/* ── Proceed footer ── */}
      {allAnswered && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-3"
          style={{ borderTop: `1px solid ${COLORS.border}`, background: `${COLORS.success}0A` }}
        >
          <div className="flex items-center gap-2">
            <CheckCircle weight="bold" className="h-4 w-4 shrink-0" style={{ color: COLORS.success }} />
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.success }}>
              ALL QUESTIONS ANSWERED
            </span>
          </div>
          <button
            style={primaryButton()}
            onClick={() => void handleProceed()}
            disabled={proceedBusy}
          >
            <ArrowRight className="h-3 w-3" />
            APPROVE PLAN & PROCEED
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuestionCard sub-component
// ---------------------------------------------------------------------------

function QuestionCard({
  index,
  total,
  meta,
  state,
  onChangeAnswer,
  onSubmit,
}: {
  index: number;
  total: number;
  meta: PlannerClarifyMeta;
  state: QuestionState;
  onChangeAnswer: (answer: string) => void;
  onSubmit: (useDefault: boolean) => void;
}) {
  const isAnswered = state.kind === "answered";
  const isSubmitting = state.kind === "submitting";
  const isError = state.kind === "error";
  const currentAnswer = state.kind === "pending" || state.kind === "error" ? state.answer : "";

  const canSubmit = !isAnswered && !isSubmitting;
  const hasTyped = currentAnswer.trim().length > 0;

  return (
    <div
      style={{
        background: isAnswered ? `${COLORS.success}08` : COLORS.recessedBg,
        border: `1px solid ${isAnswered ? `${COLORS.success}30` : COLORS.border}`,
        padding: 16,
      }}
    >
      {/* Question header */}
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 flex items-center justify-center"
          style={{
            width: 22,
            height: 22,
            background: isAnswered ? `${COLORS.success}20` : `${COLORS.accent}18`,
            border: `1px solid ${isAnswered ? `${COLORS.success}40` : COLORS.accentBorder}`,
            fontFamily: MONO_FONT,
            fontSize: 10,
            fontWeight: 700,
            color: isAnswered ? COLORS.success : COLORS.accent,
          }}
        >
          {isAnswered ? <CheckCircle className="h-3.5 w-3.5" /> : `Q${index + 1}`}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span
              style={{
                ...LABEL_STYLE,
                color: COLORS.textDim,
              }}
            >
              QUESTION {index + 1} OF {total}
            </span>
            {isAnswered && (
              <span
                style={{
                  ...LABEL_STYLE,
                  color: COLORS.success,
                }}
              >
                {state.kind === "answered" && state.source === "default_assumption"
                  ? "DEFAULT APPLIED"
                  : "ANSWERED"}
              </span>
            )}
          </div>

          {/* Question text */}
          <div
            className="mt-1.5"
            style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, lineHeight: 1.5 }}
          >
            {meta.question}
          </div>

          {/* Context */}
          {meta.context && (
            <div
              className="mt-2"
              style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5 }}
            >
              {meta.context}
            </div>
          )}

          {/* Impact */}
          {meta.impact && (
            <div
              className="mt-2 flex items-start gap-1.5"
              style={{
                background: `${COLORS.warning}0D`,
                border: `1px solid ${COLORS.warning}25`,
                padding: "6px 10px",
              }}
            >
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.warning, fontWeight: 700, whiteSpace: "nowrap" }}>
                IMPACT:
              </span>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                {meta.impact}
              </span>
            </div>
          )}

          {/* Default assumption */}
          {meta.defaultAssumption && (
            <div
              className="mt-2 flex items-start gap-1.5"
              style={{
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                padding: "6px 10px",
              }}
            >
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, fontWeight: 700, whiteSpace: "nowrap" }}>
                DEFAULT:
              </span>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                {meta.defaultAssumption}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Answer section */}
      {isAnswered ? (
        <div className="mt-3 ml-[34px]">
          <div style={{ ...LABEL_STYLE, color: COLORS.textMuted, marginBottom: 4 }}>
            {state.source === "default_assumption" ? "ASSUMPTION USED" : "YOUR ANSWER"}
          </div>
          <div
            style={{
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textPrimary,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.border}`,
              padding: "8px 10px",
              lineHeight: 1.5,
            }}
          >
            {state.answer}
          </div>
        </div>
      ) : (
        <div className="mt-3 ml-[34px] space-y-2.5">
          {/* Error message */}
          {isError && (
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ background: `${COLORS.danger}12`, border: `1px solid ${COLORS.danger}30` }}
            >
              <X className="h-3 w-3 shrink-0" style={{ color: COLORS.danger }} />
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.danger }}>
                {state.errorMsg}
              </span>
            </div>
          )}

          {/* Text input */}
          <textarea
            rows={3}
            placeholder="Type your answer here..."
            value={currentAnswer}
            disabled={isSubmitting}
            onChange={(e) => onChangeAnswer(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              resize: "vertical",
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: 12,
              padding: "8px 10px",
              lineHeight: 1.5,
              outline: "none",
              opacity: isSubmitting ? 0.5 : 1,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = COLORS.accent;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = COLORS.outlineBorder;
            }}
          />

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              style={primaryButton({
                opacity: !canSubmit || !hasTyped ? 0.5 : 1,
                cursor: !canSubmit || !hasTyped ? "not-allowed" : "pointer",
              })}
              disabled={!canSubmit || !hasTyped}
              onClick={() => onSubmit(false)}
            >
              {isSubmitting && !hasTyped ? "..." : "SUBMIT ANSWER"}
            </button>

            {meta.defaultAssumption && (
              <button
                style={outlineButton({
                  opacity: !canSubmit ? 0.5 : 1,
                  cursor: !canSubmit ? "not-allowed" : "pointer",
                })}
                disabled={!canSubmit}
                onClick={() => onSubmit(true)}
              >
                USE DEFAULT
              </button>
            )}

            {!meta.defaultAssumption && (
              <button
                style={outlineButton({
                  opacity: !canSubmit ? 0.5 : 1,
                  cursor: !canSubmit ? "not-allowed" : "pointer",
                })}
                disabled={!canSubmit}
                onClick={() => onSubmit(true)}
              >
                SKIP
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
