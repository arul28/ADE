import { useState } from "react";
import { Chat, ChatCircleDots, Check, Prohibit } from "@phosphor-icons/react";
import type { PendingInputQuestion, PendingInputRequest } from "../../../shared/types";
import { pendingInputHeaderLabel, providerDisplayName } from "../../../shared/pendingInputLabels";
import { cn } from "../ui/cn";
import {
  CHAT_CARD_MICRO_TEXT,
  ChatCard,
  ChatCardRow,
  ChatCardSub,
  ChatCardTitle,
} from "./chatCardPrimitives";

/**
 * The transcript record of a question, once it is no longer the composer's
 * problem.
 *
 * Built from `chatCardPrimitives` on the `AdeCard` convention so it lines up
 * column-for-column with every other transcript row rather than inventing its
 * own indent and width. Per that file's own rule — *"a quiet result is ONE
 * line, no box, hairline rule"* — the resolved state is a single expandable
 * line: the header verb and what was sent, with the per-question detail
 * (header · answer · note) behind a click.
 *
 * A declined request records as declined rather than vanishing: the model
 * proceeded on its own assumption and the transcript should say so.
 *
 * The answers come off the `pending_input_resolved` event, which is durable,
 * so this survives a reload. An `isSecret` question's answer never reaches
 * that event, so it renders as "answer hidden" — the absence is the feature.
 */

/**
 * Split one question's stored answer into the option labels that were picked
 * and the free text that was typed alongside them. Values that match an
 * offered option are picks; anything else is the note, which is exactly the
 * ordering `buildAnswers` guarantees (selection first, note last).
 */
export function splitAnswerIntoPicksAndNote(
  question: Pick<PendingInputQuestion, "options">,
  value: string | string[] | undefined,
): { picks: string[]; note: string } {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  const picks: string[] = [];
  const notes: string[] = [];
  for (const entry of values) {
    const label = byValue.get(entry);
    if (label != null) picks.push(label);
    else notes.push(entry);
  }
  return { picks, note: notes.join(" ") };
}

function answerSummary(
  questions: readonly PendingInputQuestion[],
  answers: Record<string, string | string[]> | undefined,
): string {
  const parts: string[] = [];
  for (const question of questions) {
    if (question.isSecret) {
      parts.push("answer hidden");
      continue;
    }
    const { picks, note } = splitAnswerIntoPicksAndNote(question, answers?.[question.id]);
    const first = picks[0] ?? note;
    if (first) parts.push(first);
  }
  return parts.join(" · ");
}

export function AnsweredQuestionReceipt({
  request,
  resolution,
  answers,
  headerLabel,
}: {
  request: PendingInputRequest;
  resolution: "accepted" | "declined" | "cancelled";
  answers?: Record<string, string | string[]> | undefined;
  headerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const questions = request.questions;
  const provider = providerDisplayName(request.source);
  const label = headerLabel ?? pendingInputHeaderLabel(request.source, request.kind);
  const summary = resolution === "accepted" ? answerSummary(questions, answers) : "";

  const meta = resolution === "accepted"
    ? (open ? "hide" : "answered")
    : resolution === "declined" ? "declined" : "closed";

  return (
    <ChatCard skin="line" data-testid="answered-question-receipt">
      <button
        type="button"
        aria-expanded={open}
        data-testid="answered-question-receipt-toggle"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full rounded-md py-0.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <ChatCardRow
          tone={resolution === "accepted" ? "ok" : "idle"}
          icon={resolution === "accepted" ? Check : resolution === "declined" ? Prohibit : ChatCircleDots}
          meta={meta}
        >
          {resolution === "accepted" ? (
            <ChatCardTitle>
              <span className="font-normal text-fg/55">{label} · </span>
              {summary || "answered"}
            </ChatCardTitle>
          ) : (
            <ChatCardSub>
              {resolution === "declined"
                ? `${provider} asked — you declined, it proceeded on its own assumption`
                : `${provider} asked — the request closed before it was answered`}
            </ChatCardSub>
          )}
        </ChatCardRow>
      </button>
      {open ? (
        <div
          data-testid="answered-question-receipt-detail"
          className="ml-[26px] mt-1 border-l border-white/[0.06] pl-3"
        >
          {questions.map((question) => {
            const { picks, note } = question.isSecret
              ? { picks: [], note: "" }
              : splitAnswerIntoPicksAndNote(question, answers?.[question.id]);
            return (
              <div key={question.id} className="py-1">
                <div className={cn("font-mono font-bold uppercase tracking-[0.16em] text-fg/26", CHAT_CARD_MICRO_TEXT)}>
                  {question.header?.trim() || question.question}
                </div>
                {question.isSecret ? (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[length:calc(var(--chat-font-size)*12/14)] text-fg/40">
                    <Chat size={11} weight="regular" /> answer hidden
                  </div>
                ) : (
                  <>
                    {picks.length ? (
                      <div className="mt-0.5 text-[length:calc(var(--chat-font-size)*12/14)] text-fg/72">
                        {picks.join(" · ")}
                      </div>
                    ) : null}
                    {note ? (
                      <div className="mt-1 text-[length:calc(var(--chat-font-size)*12/14)] italic text-fg/62">
                        note: “{note}”
                      </div>
                    ) : null}
                    {!picks.length && !note ? (
                      <div className="mt-0.5 text-[length:calc(var(--chat-font-size)*12/14)] text-fg/26">
                        {resolution === "accepted" ? "no answer recorded" : "unanswered"}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </ChatCard>
  );
}

/**
 * The transcript placeholder while the question is still open. The card itself
 * lives in the composer now, so this row exists only to keep the transcript's
 * record continuous and to name where the controls went — a queued second
 * question surfaces here until it becomes the composer's primary gate.
 */
export function OpenQuestionReceipt({
  request,
  headerLabel,
}: {
  request: PendingInputRequest;
  headerLabel?: string;
}) {
  const label = headerLabel ?? pendingInputHeaderLabel(request.source, request.kind);
  const first = request.questions[0];
  return (
    <ChatCard skin="line" data-testid="open-question-receipt">
      <ChatCardRow tone="running" icon={ChatCircleDots} meta="awaiting you">
        <ChatCardTitle>
          <span className="font-normal text-fg/55">{label} · </span>
          {first?.header?.trim() || first?.question || request.description || "Waiting for your answer"}
        </ChatCardTitle>
        <ChatCardSub>Answer it in the composer below.</ChatCardSub>
      </ChatCardRow>
    </ChatCard>
  );
}
