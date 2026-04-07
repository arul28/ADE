import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  Bug,
  ChatCircleDots,
  Lightbulb,
  Question,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
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

function NewReportTab({
  hasGithubToken,
  onSubmitted,
}: {
  hasGithubToken: boolean;
  onSubmitted: () => void;
}) {
  const availableModels = useAppStore((s) => s.availableModels);
  const availableModelIds = availableModels.map((m) => m.id);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState("");
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
  }, [category, description, modelId, submitting, onSubmitted]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, []);

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
        <UnifiedModelSelector
          value={modelId}
          onChange={setModelId}
          availableModelIds={availableModelIds}
          catalogMode="available-only"
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
          disabled={!description.trim() || !modelId || submitting}
          onClick={handleSubmit}
          style={{
            height: 32,
            padding: "0 20px",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            background: !description.trim() || !modelId || submitting ? COLORS.textDim : COLORS.accent,
            color: "#fff",
            border: "none",
            cursor: !description.trim() || !modelId || submitting ? "not-allowed" : "pointer",
            opacity: !description.trim() || !modelId || submitting ? 0.5 : 1,
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
  const sl = statusLabel(submission.status);
  const preview =
    submission.generatedTitle || submission.userDescription.slice(0, 80);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.border}`,
      }}
    >
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

      {submission.issueUrl ? (
        <button
          type="button"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: COLORS.textMuted,
            transition: "color 0.15s",
          }}
          onClick={() => window.ade.app.openExternal(submission.issueUrl!)}
          title={`Open issue #${submission.issueNumber}`}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = COLORS.textPrimary; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = COLORS.textMuted; }}
        >
          <ArrowSquareOut size={12} weight="bold" />
        </button>
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

  return (
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
    </AnimatePresence>
  );
}
