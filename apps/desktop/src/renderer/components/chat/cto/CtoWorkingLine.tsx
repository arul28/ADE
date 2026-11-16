import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight, Check } from "@phosphor-icons/react";
import type { OperatorNavigationSuggestion } from "../../../../shared/types";
import { subscribeToTicker } from "../../../lib/ticker";
import { CtoAvatar } from "../../cto/avatar/CtoAvatar";
import { useCtoLook } from "../../cto/ctoLook";
import { ChatToolActivityDetails } from "../ChatWorkLogBlock";
import type { ChatWorkLogEntry } from "../chatTranscriptRows";
import { ctoLatestStepWords, ctoStepList } from "./ctoToolWords";
import "./ctoChat.css";

function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe < 60) return `${safe}s`;
  return `${Math.floor(safe / 60)}m ${String(safe % 60).padStart(2, "0")}s`;
}

/**
 * The CTO thread's live turn, in one line: its avatar at work, the step it is
 * on in plain words ("Checking PR #12"), and how long the turn has run. Click
 * to see the steps so far; the raw tool calls are one more click away.
 *
 * Stands in for the generic working indicator on the CTO surface only. The
 * elapsed counter writes its text through a ref on the shared one-second
 * ticker, so a long turn costs no React commit per second.
 */
export function CtoWorkingLine({
  activity,
  startedAt,
  toolEntries,
  onNavigateSuggestion,
  onInsertDraft,
  onRevealChatTerminal,
  sessionId,
}: {
  /** The generic label (what the provider says it is doing), used when no step has plain words. */
  activity: string | null;
  startedAt: number | null;
  toolEntries: ChatWorkLogEntry[];
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  sessionId?: string | null;
}) {
  const look = useCtoLook();
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const timerRef = useRef<HTMLSpanElement | null>(null);
  const startMsRef = useRef<number | null>(null);

  const attachTimer = useCallback((el: HTMLSpanElement | null) => {
    timerRef.current = el;
    if (!el) return;
    const startMs = startMsRef.current ?? startedAt ?? Date.now();
    el.textContent = formatElapsed((Date.now() - startMs) / 1000);
  }, [startedAt]);

  useEffect(() => {
    const startMs = startedAt ?? Date.now();
    startMsRef.current = startMs;
    const tick = () => {
      const el = timerRef.current;
      if (el) el.textContent = formatElapsed((Date.now() - startMs) / 1000);
    };
    tick();
    return subscribeToTicker(1000, tick);
  }, [startedAt]);

  const running = toolEntries.some((entry) => entry.status === "running");
  // The provider's generic waits ("Calling tool", "Running command") say
  // nothing a person can use; the CTO line says "Working" instead.
  const plainActivity = activity && !/^(calling tool|running command|tool calling)$/i.test(activity.trim()) ? activity : null;
  const step = ctoLatestStepWords(toolEntries) ?? plainActivity ?? (running || activity ? "Working" : "Thinking");
  const steps = useMemo(() => (open ? ctoStepList(toolEntries) : []), [open, toolEntries]);
  const hasSteps = toolEntries.length > 0;
  const Caret = open ? CaretDown : CaretRight;

  const line = (
    <>
      <CtoAvatar look={look} state={!running && activity === "Thinking" ? "thinking" : "working"} size={16} motion="lazy" />
      <span className="ade-cto-working-step" title={step}>{step}</span>
      <span className="ade-cto-working-sep" aria-hidden>·</span>
      <span ref={attachTimer} className="ade-cto-working-time">0s</span>
      {hasSteps ? <Caret size={9} weight="bold" className="ade-cto-working-caret" aria-hidden /> : null}
    </>
  );

  return (
    <div className="ade-cto-working" data-testid="cto-working-line" data-open={open ? "true" : undefined}>
      {hasSteps ? (
        <button
          type="button"
          className="ade-cto-working-line"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} steps: ${step}`}
          onClick={() => setOpen((value) => !value)}
        >
          {line}
        </button>
      ) : (
        <div className="ade-cto-working-line" role="status">{line}</div>
      )}
      {open && hasSteps ? (
        <div className="ade-cto-working-steps">
          <ol>
            {steps.map((entry) => (
              <li key={entry.id} data-status={entry.status}>
                {entry.status === "running"
                  ? <span className="ade-cto-working-dot" aria-hidden />
                  : <Check size={10} weight="bold" className="ade-cto-working-check" aria-hidden />}
                <span>{entry.words}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="ade-cto-working-details-toggle" onClick={() => setDetailsOpen((value) => !value)}>
            {detailsOpen ? "Hide tool calls" : "Show tool calls"}
          </button>
          {detailsOpen ? (
            <div className="ade-cto-working-details">
              <ChatToolActivityDetails
                entries={toolEntries}
                onNavigateSuggestion={onNavigateSuggestion}
                onInsertDraft={onInsertDraft}
                onRevealChatTerminal={onRevealChatTerminal}
                sessionId={sessionId}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
