import React, { useState } from "react";
import { CaretRight, Waveform } from "@phosphor-icons/react";
import type { AgentChatVoiceSession } from "../../../shared/types";
import { formatCodexVoiceDuration } from "../../../shared/codexVoice";
import { CHAT_CARD_BODY_TEXT, ChatCard, ChatCardDetail, ChatCardRow, ChatCardSub, ChatCardTitle } from "./chatCardPrimitives";
import { cn } from "../ui/cn";

/**
 * What a finished voice conversation leaves in the chat.
 *
 * This replaced a flat "INFO" pill whose summary repeated the numbers and whose
 * whole transcript hid behind a chevron. A call is something the user did, not
 * a system event, so it gets the transcript cards' own vocabulary: a `ChatCard`
 * head saying what it was, how long it ran and what came of it, with the
 * transcript opening underneath.
 *
 * The accent is spent on the "Voice" label only — the one thing on the card
 * that is the voice's — rather than tinting the whole surface.
 */
export function VoiceSessionCard({ session }: { session: AgentChatVoiceSession }) {
  const [open, setOpen] = useState(false);

  const facts: string[] = [];
  if (session.requests) facts.push(`${session.requests} ${session.requests === 1 ? "request" : "requests"}`);
  if (session.handoffs) facts.push(`${session.handoffs} handed to the agent`);
  if (session.endedByVoice) facts.push("you asked it to end");
  if (!facts.length && !session.error) facts.push("no requests");

  return (
    <ChatCard skin="bordered" data-voice-session-card="">
      <ChatCardRow
        tone="neutral"
        icon={Waveform}
        meta={formatCodexVoiceDuration(session.durationMs)}
        action={(
          <CaretRight
            size={11}
            aria-hidden
            className={cn("text-fg/35 transition-transform", open && "rotate-90")}
          />
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="block w-full min-w-0 text-left"
        >
          <ChatCardTitle>Voice conversation</ChatCardTitle>
          <ChatCardSub className={session.error ? "text-amber-300/80" : undefined}>
            {session.error ? `${facts.join(" · ")} · ended: ${session.error}` : facts.join(" · ")}
          </ChatCardSub>
        </button>
      </ChatCardRow>

      {open ? (
        <ChatCardDetail>
          {session.transcript.length ? session.transcript.map((line, index) => (
            <div
              key={`${line.role}-${index}`}
              className={cn("grid grid-cols-[34px_minmax(0,1fr)] gap-2 py-[3px]", CHAT_CARD_BODY_TEXT)}
            >
              <span className={cn(
                "pt-[1px] text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em]",
                line.role === "user" ? "text-fg/35" : "text-[color:color-mix(in_srgb,var(--chat-accent)_75%,transparent)]",
              )}>
                {line.role === "user" ? "You" : "Voice"}
              </span>
              <span className={cn("min-w-0", line.role === "user" ? "text-fg/55" : "text-fg/80")}>
                {line.text}
              </span>
            </div>
          )) : (
            <div className={cn("py-[3px] text-fg/45", CHAT_CARD_BODY_TEXT)}>Nothing was said.</div>
          )}
        </ChatCardDetail>
      ) : null}
    </ChatCard>
  );
}
