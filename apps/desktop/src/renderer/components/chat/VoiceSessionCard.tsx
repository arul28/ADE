import React, { useState } from "react";
import { CaretRight, Waveform } from "@phosphor-icons/react";
import type { AgentChatNoticeDetail } from "../../../shared/types";
import { formatCodexVoiceDuration } from "../../../shared/codexVoice";
import { cn } from "../ui/cn";

/**
 * What a finished voice conversation leaves in the chat.
 *
 * This replaced a flat "INFO" pill whose summary repeated the numbers and whose
 * whole transcript hid behind a chevron. A call is something the user did, not
 * a system event, so it gets a head that says what it was, how long it ran and
 * what came of it, with the transcript opening underneath.
 *
 * The accent is used for the waveform and the "Voice" label only: those are the
 * things that are the voice's, and colouring the whole card would spend the
 * accent on nothing.
 */
export function VoiceSessionCard({ session }: { session: NonNullable<AgentChatNoticeDetail["voiceSession"]> }) {
  const [open, setOpen] = useState(false);

  const facts: string[] = [];
  if (session.requests) facts.push(`${session.requests} ${session.requests === 1 ? "request" : "requests"}`);
  if (session.handoffs) facts.push(`${session.handoffs} handed to the agent`);
  if (session.endedByVoice) facts.push("you asked it to end");
  if (!facts.length && !session.error) facts.push("no requests");

  return (
    <div
      className="max-w-[var(--chat-content-width,52rem)] overflow-hidden rounded-xl border border-border/14 bg-surface-recessed/70 font-sans"
      data-voice-session-card=""
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-fg/[0.03]"
      >
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] text-[var(--chat-accent)]"
        >
          <Waveform size={12} weight="fill" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-[length:calc(var(--chat-font-size)*11.5/14)] font-medium text-fg/80">
              Voice conversation
            </span>
            <span className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums text-muted-fg/50">
              {formatCodexVoiceDuration(session.durationMs)}
            </span>
          </span>
          <span className={cn(
            "mt-0.5 block truncate text-[length:calc(var(--chat-font-size)*10/14)]",
            session.error ? "text-amber-300/80" : "text-muted-fg/50",
          )}>
            {session.error ? `${facts.join(" · ")} · ended: ${session.error}` : facts.join(" · ")}
          </span>
        </span>
        <CaretRight
          size={11}
          aria-hidden
          className={cn("shrink-0 text-muted-fg/40 transition-transform", open && "rotate-90")}
        />
      </button>

      {open ? (
        <div className="border-t border-border/10 px-3 py-2">
          {session.transcript.length ? session.transcript.map((line, index) => (
            <div
              key={`${line.role}-${index}`}
              className="flex gap-2.5 py-0.5 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed"
            >
              <span className={cn(
                "w-8 shrink-0 pt-[2px] text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em]",
                line.role === "user" ? "text-muted-fg/40" : "text-[color:color-mix(in_srgb,var(--chat-accent)_75%,transparent)]",
              )}>
                {line.role === "user" ? "You" : "Voice"}
              </span>
              <span className={cn("min-w-0 flex-1", line.role === "user" ? "text-fg/55" : "text-fg/82")}>
                {line.text}
              </span>
            </div>
          )) : (
            <div className="py-0.5 text-[length:calc(var(--chat-font-size)*11/14)] text-muted-fg/45">
              Nothing was said.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
