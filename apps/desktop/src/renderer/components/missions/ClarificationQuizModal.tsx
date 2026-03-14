import React, { useState, useCallback, useMemo } from "react";
import { X, CaretLeft, CaretRight, CheckCircle, Warning, Question, Flag } from "@phosphor-icons/react";
import type {
  ClarificationQuestion,
  ClarificationAnswer,
  ClarificationQuiz,
  MissionInterventionResolutionKind,
} from "../../../shared/types";
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

export type ClarificationQuizModalProps = {
  interventionId: string;
  missionId: string;
  questions: ClarificationQuestion[];
  phase?: string | null;
  onSubmit: (quiz: ClarificationQuiz, resolutionKind?: MissionInterventionResolutionKind) => Promise<void>;
  onClose: () => void;
};

type DraftAnswer = {
  text: string;
  selectedOption: string | null;
  markedConfusing: boolean;
  useDefault: boolean;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ClarificationQuizModal({
  questions,
  phase,
  onSubmit,
  onClose,
}: ClarificationQuizModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() =>
    questions.map(() => ({
      text: "",
      selectedOption: null,
      markedConfusing: false,
      useDefault: false,
    }))
  );
  const [submitting, setSubmitting] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  const currentQuestion = questions[currentIndex];
  const currentDraft = drafts[currentIndex];
  const total = questions.length;

  const updateDraft = useCallback((index: number, patch: Partial<DraftAnswer>) => {
    setDrafts((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  const hasAnswer = useCallback((index: number) => {
    const d = drafts[index];
    return d.useDefault || d.text.trim().length > 0 || d.selectedOption !== null;
  }, [drafts]);

  const allAnswered = useMemo(() =>
    drafts.every((_, i) => hasAnswer(i)),
    [drafts, hasAnswer]
  );

  const answeredCount = useMemo(() =>
    drafts.filter((_, i) => hasAnswer(i)).length,
    [drafts, hasAnswer]
  );
  const canAcceptDefaults = useMemo(
    () => questions.every((question) => typeof question.defaultAssumption === "string" && question.defaultAssumption.trim().length > 0),
    [questions],
  );

  const handleNext = useCallback(() => {
    if (currentIndex < total - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      setShowSummary(true);
    }
  }, [currentIndex, total]);

  const handleBack = useCallback(() => {
    if (showSummary) {
      setShowSummary(false);
    } else if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex, showSummary]);

  const buildQuiz = useCallback((forceDefaults = false): ClarificationQuiz => {
    const answers: ClarificationAnswer[] = drafts.map((d, i) => ({
      questionIndex: i,
      answer: forceDefaults
        ? (questions[i].defaultAssumption ?? "")
        : d.useDefault
          ? (questions[i].defaultAssumption ?? "")
          : (d.selectedOption ?? d.text.trim()),
      source: forceDefaults || d.useDefault ? "default_assumption" as const : "user" as const,
      markedConfusing: d.markedConfusing || undefined,
    }));
    return {
      questions,
      answers,
      phase: phase ?? undefined,
      submittedAt: new Date().toISOString(),
    };
  }, [drafts, phase, questions]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      await onSubmit(buildQuiz(false), "answer_provided");
    } finally {
      setSubmitting(false);
    }
  }, [buildQuiz, onSubmit]);

  const handleResolveAction = useCallback(async (resolutionKind: MissionInterventionResolutionKind) => {
    setSubmitting(true);
    try {
      const quiz = buildQuiz(resolutionKind === "accept_defaults");
      await onSubmit(quiz, resolutionKind);
    } finally {
      setSubmitting(false);
    }
  }, [buildQuiz, onSubmit]);

  // Overlay backdrop
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.7)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: COLORS.pageBg,
          border: `1px solid ${COLORS.border}`,
          width: "100%",
          maxWidth: 640,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
            background: COLORS.cardBg,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Question weight="bold" style={{ color: COLORS.accent, width: 16, height: 16 }} />
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
              Planning Questions
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
              {answeredCount}/{total} answered
            </span>
            <button
              onClick={onClose}
              style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* ── Phase badge ── */}
        {phase && (
          <div style={{ padding: "8px 16px", borderBottom: `1px solid ${COLORS.border}` }}>
            <span
              style={{
                ...LABEL_STYLE,
                color: COLORS.textDim,
              }}
            >
              PHASE: {phase.toUpperCase()}
            </span>
          </div>
        )}

        {/* ── Body ── */}
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {showSummary ? (
            <SummaryView
              questions={questions}
              drafts={drafts}
              onEditQuestion={(i) => { setShowSummary(false); setCurrentIndex(i); }}
            />
          ) : (
            <QuestionView
              question={currentQuestion}
              draft={currentDraft}
              index={currentIndex}
              total={total}
              onUpdateDraft={(patch) => updateDraft(currentIndex, patch)}
            />
          )}
        </div>

        {/* ── Footer / Navigation ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderTop: `1px solid ${COLORS.border}`,
            background: COLORS.cardBg,
          }}
        >
          <button
            style={outlineButton({
              opacity: (currentIndex === 0 && !showSummary) ? 0.4 : 1,
              cursor: (currentIndex === 0 && !showSummary) ? "not-allowed" : "pointer",
            })}
            disabled={currentIndex === 0 && !showSummary}
            onClick={handleBack}
          >
            <CaretLeft style={{ width: 12, height: 12 }} />
            BACK
          </button>

          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
            {showSummary ? "REVIEW" : `${currentIndex + 1} of ${total}`}
          </span>

          {showSummary ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                style={outlineButton({
                  opacity: (!canAcceptDefaults || submitting) ? 0.5 : 1,
                  cursor: (!canAcceptDefaults || submitting) ? "not-allowed" : "pointer",
                })}
                disabled={!canAcceptDefaults || submitting}
                onClick={() => void handleResolveAction("accept_defaults")}
              >
                USE DEFAULTS
              </button>
              <button
                style={outlineButton({
                  opacity: submitting ? 0.5 : 1,
                  cursor: submitting ? "not-allowed" : "pointer",
                })}
                disabled={submitting}
                onClick={() => void handleResolveAction("skip_question")}
              >
                SKIP QUESTION
              </button>
              <button
                style={outlineButton({
                  opacity: submitting ? 0.5 : 1,
                  cursor: submitting ? "not-allowed" : "pointer",
                })}
                disabled={submitting}
                onClick={() => void handleResolveAction("cancel_run")}
              >
                CANCEL RUN
              </button>
              <button
                style={primaryButton({
                  opacity: (!allAnswered || submitting) ? 0.5 : 1,
                  cursor: (!allAnswered || submitting) ? "not-allowed" : "pointer",
                })}
                disabled={!allAnswered || submitting}
                onClick={() => void handleSubmit()}
              >
                <CheckCircle style={{ width: 12, height: 12 }} />
                {submitting ? "SUBMITTING..." : "SUBMIT ANSWERS"}
              </button>
            </div>
          ) : (
            <button
              style={primaryButton()}
              onClick={handleNext}
            >
              {currentIndex < total - 1 ? "NEXT" : "REVIEW"}
              <CaretRight style={{ width: 12, height: 12 }} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuestionView — single question page
// ---------------------------------------------------------------------------

function QuestionView({
  question,
  draft,
  index,
  total,
  onUpdateDraft,
}: {
  question: ClarificationQuestion;
  draft: DraftAnswer;
  index: number;
  total: number;
  onUpdateDraft: (patch: Partial<DraftAnswer>) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Question counter + text */}
      <div>
        <span style={{ ...LABEL_STYLE, color: COLORS.textDim }}>
          QUESTION {index + 1} OF {total}
        </span>
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 15,
            fontWeight: 600,
            color: COLORS.textPrimary,
            lineHeight: 1.5,
            marginTop: 6,
          }}
        >
          {question.question}
        </div>
      </div>

      {/* Context info box */}
      {question.context && (
        <div
          style={{
            background: `${COLORS.info}0D`,
            border: `1px solid ${COLORS.info}25`,
            padding: "8px 12px",
          }}
        >
          <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.info, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            CONTEXT
          </span>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5, marginTop: 4 }}>
            {question.context}
          </div>
        </div>
      )}

      {/* Impact warning box */}
      {question.impact && (
        <div
          style={{
            background: `${COLORS.warning}0D`,
            border: `1px solid ${COLORS.warning}25`,
            padding: "8px 12px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <Warning weight="bold" style={{ color: COLORS.warning, width: 14, height: 14, flexShrink: 0, marginTop: 2 }} />
          <div>
            <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.warning, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              IMPACT
            </span>
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5, marginTop: 2 }}>
              {question.impact}
            </div>
          </div>
        </div>
      )}

      {/* Multiple choice options */}
      {question.options && question.options.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ ...LABEL_STYLE, color: COLORS.textDim }}>OPTIONS</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {question.options.map((opt, i) => {
              const isSelected = draft.selectedOption === opt;
              return (
                <button
                  key={i}
                  onClick={() => {
                    onUpdateDraft({
                      selectedOption: isSelected ? null : opt,
                      useDefault: false,
                    });
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "6px 14px",
                    fontSize: 12,
                    fontFamily: MONO_FONT,
                    fontWeight: 600,
                    color: isSelected ? COLORS.accent : COLORS.textSecondary,
                    background: isSelected ? `${COLORS.accent}18` : COLORS.recessedBg,
                    border: `1px solid ${isSelected ? COLORS.accent : COLORS.outlineBorder}`,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Free text area */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...LABEL_STYLE, color: COLORS.textDim }}>
          {question.options?.length ? "OR TYPE YOUR ANSWER" : "YOUR ANSWER"}
        </span>
        <textarea
          rows={3}
          placeholder="Type your answer here..."
          value={draft.text}
          onChange={(e) => onUpdateDraft({ text: e.target.value, useDefault: false })}
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
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
        />
      </div>

      {/* Default assumption hint + use default button */}
      {question.defaultAssumption && (
        <div
          style={{
            background: COLORS.recessedBg,
            border: `1px solid ${draft.useDefault ? `${COLORS.success}40` : COLORS.outlineBorder}`,
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              DEFAULT ASSUMPTION
            </span>
            <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.4, marginTop: 2 }}>
              {question.defaultAssumption}
            </div>
          </div>
          <button
            onClick={() => onUpdateDraft({ useDefault: !draft.useDefault, selectedOption: null, text: "" })}
            style={outlineButton({
              height: 26,
              padding: "0 10px",
              fontSize: 9,
              ...(draft.useDefault ? { color: COLORS.success, borderColor: `${COLORS.success}40` } : {}),
            })}
          >
            {draft.useDefault ? "DEFAULT SELECTED" : "USE DEFAULT"}
          </button>
        </div>
      )}

      {/* Mark as confusing */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => onUpdateDraft({ markedConfusing: !draft.markedConfusing })}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 8px",
            fontSize: 9,
            fontFamily: MONO_FONT,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            color: draft.markedConfusing ? COLORS.warning : COLORS.textDim,
            background: draft.markedConfusing ? `${COLORS.warning}12` : "transparent",
            border: `1px solid ${draft.markedConfusing ? `${COLORS.warning}30` : "transparent"}`,
            cursor: "pointer",
          }}
        >
          <Flag weight={draft.markedConfusing ? "fill" : "regular"} style={{ width: 10, height: 10 }} />
          {draft.markedConfusing ? "MARKED CONFUSING" : "MARK AS CONFUSING"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryView — review all answers before submit
// ---------------------------------------------------------------------------

function SummaryView({
  questions,
  drafts,
  onEditQuestion,
}: {
  questions: ClarificationQuestion[];
  drafts: DraftAnswer[];
  onEditQuestion: (index: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <span style={{ ...LABEL_STYLE, color: COLORS.accent }}>REVIEW YOUR ANSWERS</span>
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 4, lineHeight: 1.5 }}>
          Review your answers below before submitting. Click any question to edit.
        </div>
      </div>

      {questions.map((q, i) => {
        const d = drafts[i];
        const answerText = d.useDefault
          ? (q.defaultAssumption ?? "(no default)")
          : ((d.selectedOption ?? d.text.trim()) || "(no answer)");
        const hasAns = d.useDefault || d.text.trim().length > 0 || d.selectedOption !== null;

        return (
          <div
            key={i}
            onClick={() => onEditQuestion(i)}
            style={{
              background: hasAns ? `${COLORS.success}08` : COLORS.recessedBg,
              border: `1px solid ${hasAns ? `${COLORS.success}30` : COLORS.border}`,
              padding: 12,
              cursor: "pointer",
              transition: "border-color 0.15s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: hasAns ? `${COLORS.success}20` : `${COLORS.accent}18`,
                    border: `1px solid ${hasAns ? `${COLORS.success}40` : COLORS.accentBorder}`,
                    fontFamily: MONO_FONT,
                    fontSize: 9,
                    fontWeight: 700,
                    color: hasAns ? COLORS.success : COLORS.accent,
                    flexShrink: 0,
                  }}
                >
                  {hasAns ? <CheckCircle style={{ width: 12, height: 12 }} /> : `${i + 1}`}
                </div>
                <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
                  {q.question}
                </span>
              </div>
              {d.markedConfusing && (
                <Flag weight="fill" style={{ color: COLORS.warning, width: 12, height: 12, flexShrink: 0 }} />
              )}
            </div>

            <div style={{ marginTop: 6, marginLeft: 28 }}>
              <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: d.useDefault ? COLORS.textMuted : COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {d.useDefault ? "DEFAULT:" : "ANSWER:"}
              </span>
              <div style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: hasAns ? COLORS.textSecondary : COLORS.textDim,
                fontStyle: hasAns ? "normal" : "italic",
                lineHeight: 1.4,
                marginTop: 2,
              }}>
                {answerText}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
