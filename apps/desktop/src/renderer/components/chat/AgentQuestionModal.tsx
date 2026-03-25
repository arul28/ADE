import { useEffect, useMemo, useState } from "react";
import { ChatCircleText, HandPalm, PaperPlaneTilt, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import { Button } from "../ui/Button";

type AgentQuestionModalProps = {
  request: PendingInputRequest;
  onClose: () => void;
  onSubmit: (args: { answers: Record<string, string | string[]>; responseText?: string | null }) => void;
  onDecline?: () => void;
};

export function AgentQuestionModal({
  request,
  onClose,
  onSubmit,
  onDecline,
}: AgentQuestionModalProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    setAnswers({});
  }, [request.itemId, request.requestId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const normalizedAnswers = useMemo(() => {
    return Object.fromEntries(
      Object.entries(answers)
        .map(([questionId, value]) => [questionId, value.trim()])
        .filter((entry): entry is [string, string] => entry[1].length > 0),
    );
  }, [answers]);

  const canSubmit = request.canProceedWithoutAnswer || request.questions.every((question) => {
    const value = normalizedAnswers[question.id];
    return typeof value === "string" && value.length > 0;
  });

  const handleSubmit = () => {
    const primaryQuestionId = request.questions[0]?.id;
    onSubmit({
      answers: { ...normalizedAnswers },
      responseText: primaryQuestionId ? (normalizedAnswers[primaryQuestionId] ?? null) : null,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(78,154,241,0.12),rgba(8,7,12,0.84))] px-4 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ade-glass-card w-full max-w-3xl overflow-hidden border-border/20 bg-[linear-gradient(180deg,rgba(18,24,38,0.94),rgba(11,15,24,0.88))] shadow-[var(--shadow-panel)]">
        <div className="flex items-center justify-between border-b border-border/15 bg-[linear-gradient(90deg,rgba(78,154,241,0.12),transparent)] px-5 py-3">
          <div className="flex items-center gap-2">
            <ChatCircleText size={16} className="text-sky-300/85" />
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-sky-200/80">
              {request.kind === "structured_question" ? "Input needed" : "Agent question"}
            </div>
            <div className="rounded-sm border border-white/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/55">
              {request.source}
            </div>
          </div>
          <button
            type="button"
            className="text-muted-fg/45 transition-colors hover:text-fg/80"
            onClick={onClose}
            aria-label="Close question modal"
          >
            <X size={14} />
          </button>
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
              const selectedValue = answers[question.id] ?? "";
              const helperText = question.defaultAssumption ?? question.impact ?? null;
              const placeholder = question.options?.length
                ? "Choose an option or type a custom answer..."
                : "Type the answer you want the agent to follow...";

              return (
                <div key={question.id} className="space-y-2 rounded-sm border border-white/[0.06] bg-black/10 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200/65">
                      {question.header?.trim() || `Question ${index + 1}`}
                    </div>
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
                    <div className="flex flex-wrap gap-2">
                      {question.options.map((option) => {
                        const isSelected = selectedValue === option.value;
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
                            onClick={() => {
                              setAnswers((current) => ({ ...current, [question.id]: option.value }));
                            }}
                          >
                            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em]">
                              {option.label}
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
                  ) : null}
                  {question.allowsFreeform !== false ? (
                    question.isSecret ? (
                      <input
                        type="password"
                        value={selectedValue}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                        placeholder={placeholder}
                        className="h-10 w-full border border-border/20 bg-[linear-gradient(180deg,rgba(17,15,26,0.94),rgba(13,11,19,0.9))] px-3 font-mono text-[12px] text-fg outline-none transition-colors placeholder:text-muted-fg/30 focus:border-sky-300/35"
                      />
                    ) : (
                      <textarea
                        value={selectedValue}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                        placeholder={placeholder}
                        className="min-h-[110px] w-full resize-y border border-border/20 bg-[linear-gradient(180deg,rgba(17,15,26,0.94),rgba(13,11,19,0.9))] px-4 py-3 font-mono text-[12px] leading-6 text-fg outline-none transition-colors placeholder:text-muted-fg/30 focus:border-sky-300/35"
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
              ? "You can skip this and let the agent continue, or send a concrete answer."
              : "Send a concrete answer so the agent can continue with the right context."}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
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
