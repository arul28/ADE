import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ChatCircleText, HandPalm, PaperPlaneTilt, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import { Button } from "../ui/Button";

type AgentQuestionModalProps = {
  request: PendingInputRequest;
  onClose: () => void;
  onSubmit: (args: { answers: Record<string, string | string[]>; responseText?: string | null }) => void;
  onDecline?: () => void;
};

type QuestionDraft = {
  text: string;
  selectedValues: string[];
  activePreviewValue: string | null;
};

const SAFE_PREVIEW_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    "p",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "br",
    "hr",
  ],
};

function createEmptyDraft(): QuestionDraft {
  return {
    text: "",
    selectedValues: [],
    activePreviewValue: null,
  };
}

export function AgentQuestionModal({
  request,
  onClose,
  onSubmit,
  onDecline,
}: AgentQuestionModalProps) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const passiveDismissAllowed = request.canProceedWithoutAnswer;
  const questionCountLabel = request.questions.length === 1 ? "1 question" : `${request.questions.length} questions`;
  const modalTitle = request.title?.trim().length
    ? request.title.trim()
    : request.kind === "structured_question"
      ? "Input needed"
      : "Agent question";

  useEffect(() => {
    setDrafts({});
  }, [request.itemId, request.requestId]);

  const getDraft = (questionId: string): QuestionDraft => drafts[questionId] ?? createEmptyDraft();

  const normalizedAnswers = useMemo(() => {
    const next: Record<string, string | string[]> = {};

    for (const question of request.questions) {
      const draft = drafts[question.id] ?? createEmptyDraft();
      const selectedValues = draft.selectedValues
        .map((value) => value.trim())
        .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
      const text = draft.text.trim();

      if (question.multiSelect) {
        const extraValues = text.length > 0
          ? text.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
          : [];
        const values = [...selectedValues];
        for (const value of extraValues) {
          if (!values.includes(value)) values.push(value);
        }
        if (values.length > 0) {
          next[question.id] = values;
        }
        continue;
      }

      if (text.length > 0) {
        next[question.id] = text;
        continue;
      }

      if (selectedValues[0]) {
        next[question.id] = selectedValues[0];
      }
    }

    return next;
  }, [drafts, request.questions]);

  const canSubmit = request.canProceedWithoutAnswer || request.questions.every((question) => {
    const value = normalizedAnswers[question.id];
    return (typeof value === "string" && value.length > 0)
      || (Array.isArray(value) && value.length > 0);
  });

  const handleSubmit = useCallback(() => {
    const primaryQuestionId = request.questions[0]?.id;
    const primaryAnswer = primaryQuestionId ? normalizedAnswers[primaryQuestionId] : undefined;
    onSubmit({
      answers: { ...normalizedAnswers },
      responseText: typeof primaryAnswer === "string" ? primaryAnswer : null,
    });
  }, [normalizedAnswers, onSubmit, request.questions]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        if (!passiveDismissAllowed) return;
        onClose();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.stopPropagation();
        event.preventDefault();
        if (!canSubmit) return;
        handleSubmit();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [canSubmit, handleSubmit, onClose, passiveDismissAllowed]);

  return (
    <div
      data-testid="agent-question-modal-overlay"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(78,154,241,0.12),rgba(8,7,12,0.84))] px-4 backdrop-blur-md"
      onClick={(event) => {
        if (passiveDismissAllowed && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ade-glass-card w-full max-w-3xl overflow-hidden border-border/20 bg-[linear-gradient(180deg,rgba(18,24,38,0.94),rgba(11,15,24,0.88))] shadow-[var(--shadow-panel)]">
        <div className="flex items-start justify-between gap-3 border-b border-border/15 bg-[linear-gradient(90deg,rgba(78,154,241,0.12),transparent)] px-5 py-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <ChatCircleText size={16} className="text-sky-300/85" />
              <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-sky-200/80">
                {request.kind === "structured_question" ? "Input needed" : "Agent question"}
              </div>
              <div className="rounded-sm border border-white/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/55">
                {request.source}
              </div>
              <div className="rounded-sm border border-sky-300/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sky-200/65">
                {questionCountLabel}
              </div>
            </div>
            <div className="text-[15px] font-semibold leading-6 text-fg">
              {modalTitle}
            </div>
          </div>
          {passiveDismissAllowed ? (
            <button
              type="button"
              className="text-muted-fg/45 transition-colors hover:text-fg/80"
              onClick={onClose}
              aria-label="Close question modal"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="space-y-4 px-5 py-5">
          {request.description ? (
            <div className="rounded-sm border border-sky-400/15 bg-[linear-gradient(180deg,rgba(78,154,241,0.08),rgba(78,154,241,0.03))] px-4 py-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200/70">
                Waiting on you
              </div>
              <div className="whitespace-pre-wrap text-[14px] leading-6 text-fg/90">
                {request.description}
              </div>
            </div>
          ) : null}

          <div className="space-y-4">
            {request.questions.map((question, index) => {
              const draft = getDraft(question.id);
              const selectedValues = draft.selectedValues;
              const selectedValue = selectedValues[0] ?? "";
              const helperText = [question.defaultAssumption, question.impact].filter((value): value is string => Boolean(value?.trim())).join(" ");
              const placeholder = question.multiSelect
                ? "Select one or more options, or type comma-separated custom answers..."
                : question.options?.length
                  ? "Choose an option or type a custom answer..."
                  : "Type the answer you want the agent to follow...";
              const normalizedQuestionAnswer = normalizedAnswers[question.id];
              const selectedAnswerValues = Array.isArray(normalizedQuestionAnswer)
                ? normalizedQuestionAnswer
                : typeof normalizedQuestionAnswer === "string" && normalizedQuestionAnswer.trim().length > 0
                  ? [normalizedQuestionAnswer.trim()]
                  : [];
              const previewOptions = (question.options ?? []).filter((option) => typeof option.preview === "string" && option.preview.trim().length > 0);
              const activePreviewOption = (
                previewOptions.find((option) => option.value === draft.activePreviewValue)
                ?? previewOptions.find((option) => selectedValues.includes(option.value))
                ?? previewOptions.find((option) => option.recommended)
                ?? previewOptions[0]
              ) ?? null;

              return (
                <div key={question.id} className="space-y-2 rounded-sm border border-white/[0.06] bg-black/10 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200/65">
                      {question.header?.trim() || `Question ${index + 1}`}
                    </div>
                    {question.multiSelect ? (
                      <div className="rounded-sm border border-sky-300/20 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-sky-200/70">
                        Multi-select
                      </div>
                    ) : null}
                    {question.isSecret ? (
                      <div className="rounded-sm border border-amber-400/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200/65">
                        Secret
                      </div>
                    ) : null}
                  </div>
                  <div className="whitespace-pre-wrap text-[13px] leading-6 text-fg/88">
                    {question.question}
                  </div>
                  {helperText ? (
                    <div className="text-[12px] leading-5 text-muted-fg/55">
                      {helperText}
                    </div>
                  ) : null}
                  {question.options?.length ? (
                    <div className={previewOptions.length ? "grid gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(260px,1.05fr)]" : "space-y-3"}>
                      <div className="flex flex-wrap gap-2">
                        {question.options.map((option) => {
                          const isSelected = question.multiSelect
                            ? selectedValues.includes(option.value)
                            : selectedValue === option.value;
                          return (
                            <button
                              key={`${question.id}:${option.value}`}
                              type="button"
                              className={[
                                "rounded-sm border px-3 py-1.5 text-left transition-colors",
                                isSelected
                                  ? "border-sky-300/45 bg-sky-400/[0.12] text-fg"
                                  : "border-white/[0.08] bg-white/[0.02] text-fg/72 hover:border-sky-300/30 hover:bg-sky-400/[0.06]",
                              ].join(" ")}
                              aria-pressed={isSelected}
                              onMouseEnter={() => {
                                if (!option.preview?.trim()) return;
                                setDrafts((current) => ({
                                  ...current,
                                  [question.id]: {
                                    ...(current[question.id] ?? createEmptyDraft()),
                                    activePreviewValue: option.value,
                                  },
                                }));
                              }}
                              onFocus={() => {
                                if (!option.preview?.trim()) return;
                                setDrafts((current) => ({
                                  ...current,
                                  [question.id]: {
                                    ...(current[question.id] ?? createEmptyDraft()),
                                    activePreviewValue: option.value,
                                  },
                                }));
                              }}
                              onClick={() => {
                                setDrafts((current) => {
                                  const existing = current[question.id] ?? createEmptyDraft();
                                  const nextSelectedValues = question.multiSelect
                                    ? (existing.selectedValues.includes(option.value)
                                        ? existing.selectedValues.filter((value) => value !== option.value)
                                        : [...existing.selectedValues, option.value])
                                    : [option.value];
                                  return {
                                    ...current,
                                    [question.id]: {
                                      ...existing,
                                      selectedValues: nextSelectedValues,
                                      activePreviewValue: option.preview?.trim().length ? option.value : existing.activePreviewValue,
                                    },
                                  };
                                });
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em]">
                                  {option.label}
                                </div>
                                {option.recommended ? (
                                  <div className="rounded-sm border border-emerald-300/20 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-emerald-200/75">
                                    Recommended
                                  </div>
                                ) : null}
                                {option.preview?.trim().length ? (
                                  <div className="rounded-sm border border-white/[0.08] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-fg/55">
                                    Preview
                                  </div>
                                ) : null}
                              </div>
                              {option.description ? (
                                <div className="mt-1 max-w-[240px] text-[11px] leading-5 text-muted-fg/55">
                                  {option.description}
                                </div>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      {!previewOptions.length && selectedAnswerValues.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {selectedAnswerValues.map((value) => (
                            <div
                              key={`${question.id}:selected:${value}`}
                              className="rounded-sm border border-sky-300/15 bg-sky-400/[0.08] px-2 py-1 text-[11px] text-sky-50/90"
                            >
                              {value}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {activePreviewOption?.preview?.trim().length ? (
                        <div className="overflow-hidden rounded-sm border border-sky-400/15 bg-[linear-gradient(180deg,rgba(78,154,241,0.08),rgba(78,154,241,0.02))]">
                          <div className="flex items-center justify-between gap-2 border-b border-sky-400/10 px-3 py-2">
                            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200/70">
                              Preview
                            </div>
                            <div className="text-[11px] text-fg/72">
                              {activePreviewOption.label}
                            </div>
                          </div>
                          <div className="max-h-[320px] overflow-auto px-3 py-3 text-[12px] leading-6 text-fg/86">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeRaw, [rehypeSanitize, SAFE_PREVIEW_SCHEMA]]}
                              components={{
                                p: ({ children }) => <p className="mb-3 whitespace-pre-wrap">{children}</p>,
                                ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>,
                                ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>,
                                li: ({ children }) => <li>{children}</li>,
                                pre: ({ children }) => (
                                  <pre className="mb-3 overflow-auto rounded-sm border border-white/[0.06] bg-black/25 p-3 font-mono text-[11px] leading-5">
                                    {children}
                                  </pre>
                                ),
                                code: ({ children, className }) => (
                                  <code className={className ?? "rounded-sm bg-black/30 px-1 py-0.5 font-mono text-[11px]"}>
                                    {children}
                                  </code>
                                ),
                                blockquote: ({ children }) => (
                                  <blockquote className="mb-3 border-l-2 border-sky-300/25 pl-3 text-muted-fg/72">
                                    {children}
                                  </blockquote>
                                ),
                                table: ({ children }) => <table className="mb-3 w-full border-collapse text-left">{children}</table>,
                                th: ({ children }) => <th className="border border-white/[0.08] px-2 py-1 font-semibold">{children}</th>,
                                td: ({ children }) => <td className="border border-white/[0.08] px-2 py-1 align-top">{children}</td>,
                              }}
                            >
                              {activePreviewOption.preview}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {question.options?.length && question.allowsFreeform !== false ? (
                    <div className="text-[11px] leading-5 text-muted-fg/55">
                      {question.multiSelect
                        ? "Selected options stay active while you add custom answers. Separate custom answers with commas."
                        : "Leave the text box empty to send the selected option as-is. Typing a custom answer overrides the selection."}
                    </div>
                  ) : null}
                  {question.allowsFreeform !== false ? (
                    question.isSecret ? (
                      <input
                        type="password"
                        value={draft.text}
                        onChange={(event) => {
                          const nextText = event.target.value;
                          setDrafts((current) => {
                            const existing = current[question.id] ?? createEmptyDraft();
                            return {
                              ...current,
                              [question.id]: {
                                ...existing,
                                text: nextText,
                                selectedValues:
                                  !question.multiSelect
                                    && nextText.trim().length > 0
                                    && existing.selectedValues.length > 0
                                    && nextText.trim() !== existing.selectedValues[0]
                                    ? []
                                    : existing.selectedValues,
                              },
                            };
                          });
                        }}
                        placeholder={placeholder}
                        className="h-10 w-full border border-border/20 bg-[linear-gradient(180deg,rgba(17,15,26,0.94),rgba(13,11,19,0.9))] px-3 font-mono text-[12px] text-fg outline-none transition-colors placeholder:text-muted-fg/30 focus:border-sky-300/35"
                        aria-label={question.header?.trim() || question.question}
                      />
                    ) : (
                      <textarea
                        value={draft.text}
                        onChange={(event) => {
                          const nextText = event.target.value;
                          setDrafts((current) => {
                            const existing = current[question.id] ?? createEmptyDraft();
                            return {
                              ...current,
                              [question.id]: {
                                ...existing,
                                text: nextText,
                                selectedValues:
                                  !question.multiSelect
                                    && nextText.trim().length > 0
                                    && existing.selectedValues.length > 0
                                    && nextText.trim() !== existing.selectedValues[0]
                                    ? []
                                    : existing.selectedValues,
                              },
                            };
                          });
                        }}
                        placeholder={placeholder}
                        className={[
                          "w-full resize-y border border-border/20 bg-[linear-gradient(180deg,rgba(17,15,26,0.94),rgba(13,11,19,0.9))] px-4 py-3 font-mono text-[12px] leading-6 text-fg outline-none transition-colors placeholder:text-muted-fg/30 focus:border-sky-300/35",
                          question.options?.length ? "min-h-[88px]" : "min-h-[110px]",
                        ].join(" ")}
                        aria-label={question.header?.trim() || question.question}
                      />
                    )
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/15 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] px-5 py-3">
          <div className="text-[12px] text-muted-fg/55">
            {request.canProceedWithoutAnswer
              ? "You can close this and let the agent continue, or send a concrete answer. Press Cmd/Ctrl+Enter to submit."
              : "Send a concrete answer so the agent can continue with the right context. Press Cmd/Ctrl+Enter to submit."}
          </div>
          <div className="flex items-center gap-2">
            {request.canProceedWithoutAnswer && (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            )}
            {onDecline ? (
              <Button variant="danger" size="sm" onClick={onDecline}>
                <HandPalm size={12} />
                Decline
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              <PaperPlaneTilt size={12} />
              Send answer
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
