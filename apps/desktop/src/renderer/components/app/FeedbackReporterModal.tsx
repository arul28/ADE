import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  Bug,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  Lightbulb,
  Question,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import type {
  FeedbackCategory,
  FeedbackSubmission,
  FeedbackSubmitArgs,
} from "../../../shared/types/feedback";

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
  { value: "enhancement", label: "Enhancement" },
  { value: "question", label: "Question" },
];

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

const INPUT_STYLE: React.CSSProperties = {
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  borderRadius: 0,
};

function categoryIcon(cat: FeedbackCategory, size = 12) {
  switch (cat) {
    case "bug":
      return <Bug size={size} weight="bold" />;
    case "feature":
      return <Sparkle size={size} weight="bold" />;
    case "enhancement":
      return <Lightbulb size={size} weight="bold" />;
    case "question":
      return <Question size={size} weight="bold" />;
  }
}

function categoryBadgeStyle(cat: FeedbackCategory): React.CSSProperties {
  const colorMap: Record<FeedbackCategory, string> = {
    bug: "#EF4444",
    feature: "#A78BFA",
    enhancement: "#3B82F6",
    question: "#F59E0B",
  };
  const c = colorMap[cat];
  return {
    border: `1px solid ${c}33`,
    background: `${c}18`,
    color: c,
  };
}

function statusLabel(status: FeedbackSubmission["status"]): {
  text: string;
  color: string;
  pulse?: boolean;
} {
  switch (status) {
    case "pending":
      return { text: "Pending", color: COLORS.textMuted };
    case "generating":
      return { text: "Generating...", color: COLORS.accent, pulse: true };
    case "posting":
      return { text: "Posting...", color: COLORS.info, pulse: true };
    case "posted":
      return { text: "Posted", color: COLORS.success };
    case "failed":
      return { text: "Failed", color: COLORS.danger };
  }
}

function formatSubmissionTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function NewReportTab({
  hasGithubToken,
  onSubmitted,
}: {
  hasGithubToken: boolean;
  onSubmitted: () => void;
}) {
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);
  const availableModels = useAppStore((s) => s.availableModels);
  const availableModelIds = availableModels.map((m) => m.id);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const flashTimer = useRef<number | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!description.trim() || !modelId || submitting) return;
    setSubmitting(true);
    try {
      const args: FeedbackSubmitArgs = {
        category,
        userDescription: description.trim(),
        modelId,
        reasoningEffort,
      };
      await window.ade.feedback.submit(args);
      setDescription("");
      setFlash({ msg: "Submitted! Report is generating in the background.", ok: true });
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 4000);
      onSubmitted();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to submit feedback";
      setFlash({ msg, ok: false });
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 6000);
    } finally {
      setSubmitting(false);
    }
  }, [category, description, modelId, reasoningEffort, submitting, onSubmitted]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, []);

  const submitDisabled = !description.trim() || !modelId || submitting;

  if (!hasGithubToken) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: "40px 0",
          textAlign: "center",
        }}
      >
        <ChatCircleDots size={28} weight="duotone" style={{ color: COLORS.textDim }} />
        <p style={{ fontSize: 12, color: COLORS.textMuted }}>
          Configure your GitHub token in Settings to submit reports.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 12 }}>
      {/* Category */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>Category</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
          style={{ ...INPUT_STYLE, height: 32, padding: "0 8px", fontSize: 12 }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {/* Description */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the bug you found or feature you'd like to see..."
          rows={4}
          style={{
            ...INPUT_STYLE,
            padding: "8px 12px",
            fontSize: 12,
            resize: "none",
            outline: "none",
          }}
        />
      </div>

      {/* Model */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>Model</span>
        <ProviderModelSelector
          value={modelId}
          onChange={(id) => { setModelId(id); setReasoningEffort(null); }}
          availableModelIds={availableModelIds}
          showReasoning
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={setReasoningEffort}
          onOpenAiSettings={openAiProvidersSettings}
        />
      </div>

      {/* Flash message */}
      {flash ? (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: flash.ok ? COLORS.success : COLORS.danger,
            background: flash.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
            border: `1px solid ${flash.ok ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)"}`,
          }}
        >
          {flash.msg}
        </div>
      ) : null}

      {/* Submit */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          disabled={submitDisabled}
          onClick={handleSubmit}
          style={{
            height: 32,
            padding: "0 20px",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            background: submitDisabled ? COLORS.textDim : COLORS.accent,
            color: "#fff",
            border: "none",
            cursor: submitDisabled ? "not-allowed" : "pointer",
            opacity: submitDisabled ? 0.5 : 1,
            transition: "opacity 0.15s, background 0.15s",
          }}
        >
          {submitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </div>
  );
}

function SubmissionRow({ submission }: { submission: FeedbackSubmission }) {
  const [expanded, setExpanded] = useState(submission.status === "failed");
  const sl = statusLabel(submission.status);
  const preview =
    submission.generatedTitle || submission.userDescription.slice(0, 80);

  useEffect(() => {
    if (submission.status === "failed") {
      setExpanded(true);
    }
  }, [submission.status]);

  return (
    <div
      style={{
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.border}`,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {expanded ? (
          <CaretDown size={12} weight="bold" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
        ) : (
          <CaretRight size={12} weight="bold" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
        )}

        <span
          style={{
            ...categoryBadgeStyle(submission.category),
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 6px",
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {categoryIcon(submission.category, 10)}
          {submission.category}
        </span>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            color: COLORS.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {preview}
        </span>

        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 600,
            fontFamily: MONO_FONT,
            color: sl.color,
            animation: sl.pulse ? "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" : undefined,
          }}
        >
          {sl.text}
        </span>
      </button>

      {expanded ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "0 12px 12px 32px",
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 8,
              paddingTop: 10,
            }}
          >
            <div>
              <div style={LABEL_STYLE}>Submitted</div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary }}>{formatSubmissionTimestamp(submission.createdAt)}</div>
            </div>
            <div>
              <div style={LABEL_STYLE}>Completed</div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary }}>{formatSubmissionTimestamp(submission.completedAt)}</div>
            </div>
            <div>
              <div style={LABEL_STYLE}>Model</div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary, wordBreak: "break-word" }}>{submission.modelId}</div>
            </div>
            <div>
              <div style={LABEL_STYLE}>Issue</div>
              {submission.issueUrl ? (
                <button
                  type="button"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: COLORS.accent,
                    fontSize: 11,
                  }}
                  onClick={() => window.ade.app.openExternal(submission.issueUrl!)}
                >
                  <ArrowSquareOut size={12} weight="bold" />
                  {submission.issueNumber ? `Open issue #${submission.issueNumber}` : "Open issue"}
                </button>
              ) : (
                <div style={{ fontSize: 11, color: COLORS.textSecondary }}>Not posted</div>
              )}
            </div>
          </div>

          <div>
            <div style={LABEL_STYLE}>Original submission</div>
            <div
              style={{
                ...INPUT_STYLE,
                padding: "8px 10px",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                color: COLORS.textSecondary,
              }}
            >
              {submission.userDescription}
            </div>
          </div>

          {submission.error ? (
            <div>
              <div style={{ ...LABEL_STYLE, color: COLORS.danger }}>Failure reason</div>
              <div
                style={{
                  padding: "8px 10px",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  color: COLORS.danger,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.2)",
                }}
              >
                {submission.error}
              </div>
            </div>
          ) : null}

          {submission.generatedTitle ? (
            <div>
              <div style={LABEL_STYLE}>Generated title</div>
              <div style={{ fontSize: 12, color: COLORS.textPrimary }}>{submission.generatedTitle}</div>
            </div>
          ) : null}

          {submission.generatedBody ? (
            <div>
              <div style={LABEL_STYLE}>Generated issue body</div>
              <div
                style={{
                  ...INPUT_STYLE,
                  padding: "8px 10px",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  color: COLORS.textSecondary,
                }}
              >
                {submission.generatedBody}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MySubmissionsTab() {
  const [submissions, setSubmissions] = useState<FeedbackSubmission[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.ade.feedback
      .list()
      .then((list) => {
        if (!cancelled) {
          setSubmissions(list);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoaded(true);
        }
      });

    const dispose = window.ade.feedback.onUpdate((event) => {
      if (cancelled) return;
      setSubmissions((prev) => {
        const idx = prev.findIndex((s) => s.id === event.submission.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = event.submission;
          return next;
        }
        return [event.submission, ...prev];
      });
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  if (!loaded) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
        <span style={{ fontSize: 11, color: COLORS.textDim }}>Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
        <span style={{ fontSize: 11, color: COLORS.danger }}>Failed to load submissions</span>
      </div>
    );
  }

  if (submissions.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "40px 0",
          textAlign: "center",
        }}
      >
        <ChatCircleDots size={24} weight="duotone" style={{ color: COLORS.textDim }} />
        <p style={{ fontSize: 11, color: COLORS.textMuted }}>No submissions yet</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 12 }}>
      {submissions.map((s) => (
        <SubmissionRow key={s.id} submission={s} />
      ))}
    </div>
  );
}

const TAB_STYLE: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 11,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  cursor: "pointer",
  transition: "color 0.15s, border-color 0.15s",
};

export function FeedbackReporterModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [hasGithubToken, setHasGithubToken] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<"new" | "submissions">("new");

  useEffect(() => {
    if (!open) return;
    void window.ade.github
      .getStatus()
      .then((status) => setHasGithubToken(status.tokenStored))
      .catch(() => setHasGithubToken(false));
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.70)" }}
          onClick={() => onOpenChange(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto"
            style={{
              background: COLORS.cardBgSolid,
              border: `1px solid ${COLORS.outlineBorder}`,
              boxShadow: "0 28px 80px -36px rgba(0,0,0,0.82)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 20px",
                height: 52,
                background: "#120F1A",
                borderBottom: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ChatCircleDots size={16} weight="bold" style={{ color: COLORS.accent }} />
                <h2
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    color: COLORS.textPrimary,
                    fontFamily: SANS_FONT,
                    margin: 0,
                  }}
                >
                  Feedback Reporter
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: COLORS.textMuted,
                  padding: 4,
                  transition: "color 0.15s",
                }}
              >
                <X size={16} weight="bold" />
              </button>
            </div>

            {/* Tabs */}
            <div
              style={{
                display: "flex",
                gap: 0,
                borderBottom: `1px solid ${COLORS.border}`,
                padding: "0 20px",
              }}
            >
              <button
                type="button"
                style={{
                  ...TAB_STYLE,
                  color: activeTab === "new" ? COLORS.textPrimary : COLORS.textMuted,
                  borderBottomColor: activeTab === "new" ? COLORS.accent : "transparent",
                }}
                onClick={() => setActiveTab("new")}
              >
                New Report
              </button>
              <button
                type="button"
                style={{
                  ...TAB_STYLE,
                  color: activeTab === "submissions" ? COLORS.textPrimary : COLORS.textMuted,
                  borderBottomColor: activeTab === "submissions" ? COLORS.accent : "transparent",
                }}
                onClick={() => setActiveTab("submissions")}
              >
                My Submissions
              </button>
            </div>

            {/* Content */}
            <div style={{ padding: "0 20px 20px" }}>
              {activeTab === "new" ? (
                hasGithubToken === null ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
                    <span style={{ fontSize: 11, color: COLORS.textDim }}>Loading...</span>
                  </div>
                ) : (
                  <NewReportTab
                    hasGithubToken={hasGithubToken}
                    onSubmitted={() => {}}
                  />
                )
              ) : (
                <MySubmissionsTab />
              )}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
