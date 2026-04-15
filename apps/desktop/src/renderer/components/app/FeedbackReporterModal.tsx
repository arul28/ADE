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
import type { AppInfo, ProjectInfo } from "../../../shared/types/core";
import type { GitCommitSummary } from "../../../shared/types/git";
import type { LaneSummary } from "../../../shared/types/lanes";
import type {
  FeedbackCategory,
  FeedbackDraftInput,
  FeedbackGenerationMode,
  FeedbackPreparedDraft,
  FeedbackPrepareDraftArgs,
  FeedbackSubmission,
  FeedbackSubmitDraftArgs,
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

const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  padding: "8px 12px",
  fontSize: 12,
  resize: "none",
  outline: "none",
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

function formattingLabel(mode: FeedbackGenerationMode | null): { text: string; color: string } | null {
  switch (mode) {
    case "ai_assisted":
      return { text: "AI assisted", color: COLORS.success };
    case "deterministic":
      return { text: "Deterministic", color: COLORS.warning };
    default:
      return null;
  }
}

type DraftFormState = {
  summary: string;
  additionalContext: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  environment: string;
  useCase: string;
  proposedSolution: string;
  alternativesConsidered: string;
  context: string;
  expectedGuidance: string;
};

function createEmptyDraftForm(): DraftFormState {
  return {
    summary: "",
    additionalContext: "",
    stepsToReproduce: "",
    expectedBehavior: "",
    actualBehavior: "",
    environment: "",
    useCase: "",
    proposedSolution: "",
    alternativesConsidered: "",
    context: "",
    expectedGuidance: "",
  };
}

function buildDraftInput(category: FeedbackCategory, form: DraftFormState): FeedbackDraftInput {
  switch (category) {
    case "bug":
      return {
        category: "bug",
        summary: form.summary,
        stepsToReproduce: form.stepsToReproduce,
        expectedBehavior: form.expectedBehavior,
        actualBehavior: form.actualBehavior,
        environment: form.environment,
        additionalContext: form.additionalContext,
      };
    case "feature":
    case "enhancement":
      return {
        category,
        summary: form.summary,
        useCase: form.useCase,
        proposedSolution: form.proposedSolution,
        alternativesConsidered: form.alternativesConsidered,
        additionalContext: form.additionalContext,
      };
    case "question":
      return {
        category: "question",
        summary: form.summary,
        context: form.context,
        expectedGuidance: form.expectedGuidance,
        additionalContext: form.additionalContext,
      };
  }
}

function labelsToInputValue(labels: string[]): string {
  return labels.join(", ");
}

function parseLabelInput(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function helperText(text: string) {
  return (
    <div style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
      {text}
    </div>
  );
}

function simplifyRef(ref: string | null | undefined): string {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return "Unknown";
  return trimmed
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
}

function describeLaneStatus(lane: LaneSummary): string {
  const parts = [lane.status.dirty ? "dirty worktree" : "clean worktree"];
  if (lane.status.ahead > 0) parts.push(`ahead ${lane.status.ahead}`);
  if (lane.status.behind > 0) parts.push(`behind ${lane.status.behind}`);
  if (lane.status.remoteBehind > 0) parts.push(`remote ahead ${lane.status.remoteBehind}`);
  if (lane.status.rebaseInProgress) parts.push("rebase in progress");
  return parts.join(", ");
}

function buildAutoEnvironmentText(args: {
  appInfo: AppInfo | null;
  project: ProjectInfo | null;
  selectedLane: LaneSummary | null;
  headCommit: GitCommitSummary | null;
}): string {
  const lines: string[] = [];
  if (args.appInfo) {
    const version = args.appInfo.appVersion.trim();
    lines.push(`ADE version: ${version}${args.appInfo.isPackaged ? "" : " (dev)"}`);
    lines.push(`Platform: ${args.appInfo.platform} ${args.appInfo.arch}`);
    lines.push(`Electron: ${args.appInfo.versions.electron}`);
  }
  if (args.project) {
    lines.push(`Project: ${args.project.displayName}`);
    lines.push(`Project base ref: ${simplifyRef(args.project.baseRef)}`);
  }
  if (args.selectedLane) {
    lines.push(`Selected lane: ${args.selectedLane.name}`);
    lines.push(`Lane branch: ${simplifyRef(args.selectedLane.branchRef)}`);
    lines.push(`Lane base ref: ${simplifyRef(args.selectedLane.baseRef)}`);
    lines.push(`Lane status: ${describeLaneStatus(args.selectedLane)}`);
  }
  if (args.headCommit) {
    lines.push(`HEAD commit: ${args.headCommit.shortSha} ${args.headCommit.subject}`);
  }
  return lines.join("\n");
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
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const availableModels = useAppStore((s) => s.availableModels);
  const availableModelIds = availableModels.map((m) => m.id);
  const selectedLane = (selectedLaneId
    ? lanes.find((lane) => lane.id === selectedLaneId)
    : lanes[0]) ?? null;
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [form, setForm] = useState<DraftFormState>(() => createEmptyDraftForm());
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [preparedDraft, setPreparedDraft] = useState<FeedbackPreparedDraft | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftLabelsText, setDraftLabelsText] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [autoEnvironmentText, setAutoEnvironmentText] = useState("");
  const flashTimer = useRef<number | null>(null);
  const lastAppliedEnvironmentRef = useRef("");

  const clearPreparedDraft = useCallback(() => {
    setPreparedDraft(null);
    setDraftTitle("");
    setDraftBody("");
    setDraftLabelsText("");
  }, []);

  const setFlashMessage = useCallback((msg: string, ok: boolean, timeoutMs: number) => {
    setFlash({ msg, ok });
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), timeoutMs);
  }, []);

  const updateField = useCallback((key: keyof DraftFormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    clearPreparedDraft();
  }, [clearPreparedDraft]);

  const applyAutoEnvironment = useCallback((nextEnvironment: string) => {
    const trimmed = nextEnvironment.trim();
    if (!trimmed) return;
    lastAppliedEnvironmentRef.current = trimmed;
    let shouldClearDraft = false;
    setForm((prev) => {
      if (prev.environment === trimmed) return prev;
      shouldClearDraft = true;
      return { ...prev, environment: trimmed };
    });
    if (shouldClearDraft) clearPreparedDraft();
  }, [clearPreparedDraft]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateEnvironment() {
      const [appInfo, latestCommit] = await Promise.all([
        window.ade.app.getInfo().catch(() => null),
        selectedLane
          ? window.ade.git
            .listRecentCommits({ laneId: selectedLane.id, limit: 1 })
            .then((commits) => commits[0] ?? null)
            .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const nextEnvironment = buildAutoEnvironmentText({
        appInfo,
        project,
        selectedLane,
        headCommit: latestCommit,
      }).trim();
      setAutoEnvironmentText(nextEnvironment);
      let shouldClearDraft = false;
      setForm((prev) => {
        const currentEnvironment = prev.environment.trim();
        const lastAppliedEnvironment = lastAppliedEnvironmentRef.current.trim();
        if (!nextEnvironment) return prev;
        if (currentEnvironment.length === 0 || currentEnvironment === lastAppliedEnvironment) {
          lastAppliedEnvironmentRef.current = nextEnvironment;
          if (prev.environment === nextEnvironment) return prev;
          shouldClearDraft = true;
          return { ...prev, environment: nextEnvironment };
        }
        return prev;
      });
      if (shouldClearDraft) clearPreparedDraft();
    }
    void hydrateEnvironment();
    return () => {
      cancelled = true;
    };
  }, [
    clearPreparedDraft,
    project,
    selectedLane,
  ]);

  const handleGenerateDraft = useCallback(async () => {
    if (!form.summary.trim() || preparing || submitting) return;
    setPreparing(true);
    try {
      const args: FeedbackPrepareDraftArgs = {
        draftInput: buildDraftInput(category, form),
        modelId: modelId.trim() || null,
        reasoningEffort: modelId.trim() ? reasoningEffort : null,
      };
      const nextDraft = await window.ade.feedback.prepareDraft(args);
      setPreparedDraft(nextDraft);
      setDraftTitle(nextDraft.title);
      setDraftBody(nextDraft.body);
      setDraftLabelsText(labelsToInputValue(nextDraft.labels));
      setFlashMessage("Draft ready. Review and edit it before posting to GitHub.", true, 4000);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to prepare feedback draft";
      setFlashMessage(msg, false, 6000);
    } finally {
      setPreparing(false);
    }
  }, [category, form, modelId, preparing, reasoningEffort, setFlashMessage, submitting]);

  const handleSubmitDraft = useCallback(async () => {
    if (!preparedDraft || !draftTitle.trim() || !draftBody.trim() || preparing || submitting) return;
    setSubmitting(true);
    try {
      const args: FeedbackSubmitDraftArgs = {
        draft: preparedDraft,
        title: draftTitle.trim(),
        body: draftBody.trim(),
        labels: parseLabelInput(draftLabelsText),
      };
      const submission = await window.ade.feedback.submitDraft(args);
      if (submission.status === "posted") {
        setForm({ ...createEmptyDraftForm(), environment: autoEnvironmentText });
        lastAppliedEnvironmentRef.current = autoEnvironmentText.trim();
        clearPreparedDraft();
        setFlashMessage(
          submission.issueNumber
            ? `Posted issue #${submission.issueNumber}.`
            : "Posted issue to GitHub.",
          true,
          5000,
        );
        onSubmitted();
      } else {
        setFlashMessage(
          submission.error ?? "GitHub posting failed. The reviewed draft was saved in My Submissions.",
          false,
          7000,
        );
        onSubmitted();
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to post feedback draft";
      setFlashMessage(msg, false, 7000);
    } finally {
      setSubmitting(false);
    }
  }, [
    clearPreparedDraft,
    draftBody,
    draftLabelsText,
    draftTitle,
    autoEnvironmentText,
    onSubmitted,
    preparedDraft,
    preparing,
    setFlashMessage,
    submitting,
  ]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, []);

  const canPrepareDraft = form.summary.trim().length > 0 && !preparing && !submitting;
  const canSubmitDraft = preparedDraft != null
    && draftTitle.trim().length > 0
    && draftBody.trim().length > 0
    && !preparing
    && !submitting;
  const draftSource = formattingLabel(preparedDraft?.generationMode ?? null);

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
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>Category</span>
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as FeedbackCategory);
            clearPreparedDraft();
          }}
          style={{ ...INPUT_STYLE, height: 32, padding: "0 8px", fontSize: 12 }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>Summary</span>
        <textarea
          value={form.summary}
          onChange={(e) => updateField("summary", e.target.value)}
          placeholder="What changed, what broke, or what should ADE do differently?"
          rows={3}
          style={TEXTAREA_STYLE}
        />
        {helperText("This becomes the Description section and fallback title seed if no AI assist is used.")}
      </div>

      {category === "bug" ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Steps to reproduce</span>
            <textarea
              value={form.stepsToReproduce}
              onChange={(e) => updateField("stepsToReproduce", e.target.value)}
              placeholder={"1. Open the feedback reporter\n2. Submit a report\n3. Observe the result"}
              rows={4}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Expected behavior</span>
            <textarea
              value={form.expectedBehavior}
              onChange={(e) => updateField("expectedBehavior", e.target.value)}
              placeholder="What should have happened?"
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Actual behavior</span>
            <textarea
              value={form.actualBehavior}
              onChange={(e) => updateField("actualBehavior", e.target.value)}
              placeholder="What actually happened?"
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={LABEL_STYLE}>Environment</span>
              <button
                type="button"
                onClick={() => applyAutoEnvironment(autoEnvironmentText)}
                disabled={!autoEnvironmentText.trim()}
                style={{
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  color: autoEnvironmentText.trim() ? COLORS.accent : COLORS.textDim,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: autoEnvironmentText.trim() ? "pointer" : "not-allowed",
                  opacity: autoEnvironmentText.trim() ? 1 : 0.5,
                }}
              >
                Refresh details
              </button>
            </div>
            <textarea
              value={form.environment}
              onChange={(e) => updateField("environment", e.target.value)}
              placeholder="OS, ADE version, repro scope, lane, or anything else that matters"
              rows={3}
              style={TEXTAREA_STYLE}
            />
            {helperText("ADE autofills version, platform, selected lane, and current lane HEAD commit when available. Edit anything before posting.")}
          </div>
        </>
      ) : null}

      {category === "feature" || category === "enhancement" ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Use case</span>
            <textarea
              value={form.useCase}
              onChange={(e) => updateField("useCase", e.target.value)}
              placeholder="Who needs this, and what workflow does it unblock?"
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Proposed solution</span>
            <textarea
              value={form.proposedSolution}
              onChange={(e) => updateField("proposedSolution", e.target.value)}
              placeholder="Describe the change you want ADE to make."
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Alternatives considered</span>
            <textarea
              value={form.alternativesConsidered}
              onChange={(e) => updateField("alternativesConsidered", e.target.value)}
              placeholder="What have you tried instead, and why was it not enough?"
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
        </>
      ) : null}

      {category === "question" ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Context</span>
            <textarea
              value={form.context}
              onChange={(e) => updateField("context", e.target.value)}
              placeholder="What were you trying to do when the question came up?"
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Expected guidance</span>
            <textarea
              value={form.expectedGuidance}
              onChange={(e) => updateField("expectedGuidance", e.target.value)}
              placeholder="What answer or guidance would unblock you?"
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </div>
        </>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>Additional context</span>
        <textarea
          value={form.additionalContext}
          onChange={(e) => updateField("additionalContext", e.target.value)}
          placeholder="Links, screenshots, workaround notes, or anything else useful."
          rows={3}
          style={TEXTAREA_STYLE}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LABEL_STYLE}>AI assist (optional)</span>
        <ProviderModelSelector
          value={modelId}
          onChange={(id) => {
            setModelId(id);
            setReasoningEffort(null);
            clearPreparedDraft();
          }}
          availableModelIds={availableModelIds}
          showReasoning
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={(value) => {
            setReasoningEffort(value);
            clearPreparedDraft();
          }}
          onOpenAiSettings={openAiProvidersSettings}
        />
        {helperText("Leave this empty to build a fully deterministic draft. If you pick a model, ADE only uses it to suggest the title and labels.")}
      </div>

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

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          disabled={!canPrepareDraft}
          onClick={handleGenerateDraft}
          style={{
            height: 32,
            padding: "0 20px",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            background: canPrepareDraft ? COLORS.accent : COLORS.textDim,
            color: "#fff",
            border: "none",
            cursor: canPrepareDraft ? "pointer" : "not-allowed",
            opacity: canPrepareDraft ? 1 : 0.5,
            transition: "opacity 0.15s, background 0.15s",
          }}
        >
          {preparing ? "Preparing..." : "Generate draft"}
        </button>
      </div>

      {preparedDraft ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: 12,
            border: `1px solid ${COLORS.border}`,
            background: COLORS.recessedBg,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div>
              <div style={LABEL_STYLE}>Draft preview</div>
              <div style={{ fontSize: 12, color: COLORS.textSecondary }}>
                Review the generated issue before ADE posts it to GitHub.
              </div>
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: draftSource?.color ?? COLORS.textMuted }}>
              {draftSource?.text ?? "Unknown"}
            </div>
          </div>

          {preparedDraft.generationWarning ? (
            <div
              style={{
                padding: "8px 10px",
                fontSize: 12,
                color: COLORS.warning,
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.2)",
                whiteSpace: "pre-wrap",
              }}
            >
              {preparedDraft.generationWarning}
            </div>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Labels</span>
            <input
              value={draftLabelsText}
              onChange={(e) => setDraftLabelsText(e.target.value)}
              placeholder="bug, enhancement"
              style={{ ...INPUT_STYLE, height: 32, padding: "0 10px", fontSize: 12 }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Title</span>
            <textarea
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              rows={2}
              style={TEXTAREA_STYLE}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={LABEL_STYLE}>Issue body</span>
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={14}
              style={{ ...INPUT_STYLE, padding: "8px 12px", fontSize: 12, resize: "vertical", outline: "none", minHeight: 240 }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={!canSubmitDraft}
              onClick={handleSubmitDraft}
              style={{
                height: 32,
                padding: "0 20px",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                background: canSubmitDraft ? COLORS.success : COLORS.textDim,
                color: "#fff",
                border: "none",
                cursor: canSubmitDraft ? "pointer" : "not-allowed",
                opacity: canSubmitDraft ? 1 : 0.5,
                transition: "opacity 0.15s, background 0.15s",
              }}
            >
              {submitting ? "Posting..." : "Post to GitHub"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SubmissionRow({ submission }: { submission: FeedbackSubmission }) {
  const [expanded, setExpanded] = useState(submission.status === "failed");
  const sl = statusLabel(submission.status);
  const formatting = formattingLabel(submission.generationMode);
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
              <div style={{ fontSize: 11, color: COLORS.textSecondary, wordBreak: "break-word" }}>
                {submission.modelId ?? "Not used"}
              </div>
            </div>
            <div>
              <div style={LABEL_STYLE}>Draft source</div>
              <div style={{ fontSize: 11, color: formatting?.color ?? COLORS.textSecondary }}>
                {formatting?.text ?? "Unknown"}
              </div>
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

          {submission.generationWarning ? (
            <div>
              <div style={{ ...LABEL_STYLE, color: COLORS.warning }}>Formatting note</div>
              <div
                style={{
                  padding: "8px 10px",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  color: COLORS.warning,
                  background: "rgba(245,158,11,0.08)",
                  border: "1px solid rgba(245,158,11,0.2)",
                }}
              >
                {submission.generationWarning}
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
