import { useEffect, useState } from "react";
import { ChatCircleText, HandPalm, PaperPlaneTilt, X } from "@phosphor-icons/react";
import { Button } from "../ui/Button";

type AgentQuestionModalProps = {
  question: string;
  onClose: () => void;
  onSubmit: (answer: string) => void;
  onDecline: () => void;
};

export function AgentQuestionModal({
  question,
  onClose,
  onSubmit,
  onDecline,
}: AgentQuestionModalProps) {
  const [answer, setAnswer] = useState("");

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

  const canSubmit = answer.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(167,139,250,0.12),rgba(8,7,12,0.84))] px-4 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ade-glass-card w-full max-w-2xl overflow-hidden border-border/20 bg-[linear-gradient(180deg,rgba(26,21,40,0.92),rgba(18,15,28,0.82))] shadow-[var(--shadow-panel)]">
        <div className="flex items-center justify-between border-b border-border/15 bg-[linear-gradient(90deg,rgba(167,139,250,0.1),transparent)] px-5 py-3">
          <div className="flex items-center gap-2">
            <ChatCircleText size={16} className="text-accent/80" />
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-accent/75">
              Agent Question
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
          <div className="rounded-sm border border-accent/20 bg-[linear-gradient(180deg,rgba(167,139,250,0.1),rgba(167,139,250,0.04))] px-4 py-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-accent/60">
              Waiting On You
            </div>
            <div className="whitespace-pre-wrap text-[14px] leading-6 text-fg/90">
              {question}
            </div>
          </div>

          <div className="space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/45">
              Your Answer
            </div>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Type the answer you want the agent to follow..."
              className="min-h-[180px] w-full resize-y border border-border/20 bg-[linear-gradient(180deg,rgba(17,15,26,0.94),rgba(13,11,19,0.9))] px-4 py-3 font-mono text-[12px] leading-6 text-fg outline-none transition-colors placeholder:text-muted-fg/30 focus:border-accent/45"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/15 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] px-5 py-3">
          <div className="text-[12px] text-muted-fg/55">
            Send a concrete answer, or decline if you want the agent to continue without new guidance.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button variant="danger" size="sm" onClick={onDecline}>
              <HandPalm size={12} />
              Decline
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSubmit(answer.trim())}
              disabled={!canSubmit}
            >
              <PaperPlaneTilt size={12} />
              Send Answer
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
