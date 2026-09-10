import React from "react";
import { Clock } from "@phosphor-icons/react";

import type {
  AgentChatUsageLimitResume,
  OpenProjectBinding,
} from "../../../shared/types";
import {
  usageLimitResumePill,
  usageLimitResumePopover,
} from "../../../shared/usageLimitResumePresentation";
import { CLAUDE_SESSION_QUOTA_CARD_ACTION } from "../../../shared/claudeSessionQuota";
import { cn } from "../ui/cn";

/**
 * The compact usage-limit pill that floats directly above the composer, and its
 * anchored popover.
 *
 * It replaces the amber "Usage limit reached / Continue automatically / Don't
 * continue" block that used to live inside the transcript's failure card. Two
 * reasons the state moved out of the transcript:
 *
 *   • the transcript scrolls, and the one control that says when this chat
 *     comes back cannot be somewhere you have to go looking for;
 *   • the block re-stated a fact the row already carried, in the one hue this
 *     product reserves for "your move" — a chat that will resume on its own at
 *     a published time is not asking for anything.
 *
 * So: neutral surface, one line, and every action behind one press. The pill is
 * absolutely-positioned-free (it is an ordinary flow child above the composer)
 * but the POPOVER is absolute, so opening it can never move the prompt box.
 */

const PILL_CLASS =
  "pointer-events-auto inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-white/[0.10] bg-[#17161c]/92 px-2.5 py-1 font-sans shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl transition-colors hover:border-white/[0.18] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25";

const POPOVER_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-md px-2.5 py-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatUsageLimitResumePill({
  sessionId,
  resume,
  runtimePin = null,
  className,
}: {
  sessionId: string;
  /** Host-computed state. The pill renders nothing when it is absent. */
  resume: AgentChatUsageLimitResume | null | undefined;
  runtimePin?: OpenProjectBinding | null;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const pill = resume ? usageLimitResumePill(resume, nowMs) : null;
  const popover = resume && open ? usageLimitResumePopover(resume, nowMs) : null;

  // ONE interval per pill, sized by the model it just produced: a resume more
  // than five minutes out re-renders once a minute, one inside five minutes
  // once a second, and a static state (resuming / paused / opted out / no
  // reset) arms no timer at all. Crossing the five-minute boundary changes
  // `refreshMs`, which re-arms the effect — no second timer, no polling. The
  // tick is state on this leaf, so it never reaches the memoized transcript.
  const refreshMs = pill?.refreshMs ?? null;
  React.useEffect(() => {
    if (refreshMs == null) return undefined;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), refreshMs);
    return () => window.clearInterval(intervalId);
  }, [refreshMs]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The state this pill renders is gone the moment an action lands, so a
  // half-finished action must not outlive it as a stuck spinner.
  React.useEffect(() => {
    setBusy(false);
    setActionError(null);
  }, [resume?.state]);

  if (!resume || !pill) return null;

  /**
   * Run one popover action.
   *
   * Three outcomes, and the popover behaves differently for each: it closes on
   * success, and STAYS OPEN carrying a sentence for both a thrown error and a
   * host refusal. A refusal is not a failure — the host declined to send
   * because there is nothing to resume or a resume is already in flight — but
   * it has the same requirement: the user must be able to read why the button
   * did nothing, with the other actions still under their cursor.
   *
   * `action` returns the sentence to show, or null when it went through.
   */
  const run = async (action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const refusal = await action();
      if (refusal) setActionError(refusal);
      else setOpen(false);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const resumeNow = () => run(async () => {
    // Optional-chained rather than called outright: this renderer is also
    // served to remote and hosted-web clients whose brain may be an older
    // build, and a missing bridge should read as one sentence in the popover,
    // not a TypeError with the popover still claiming a resume is coming.
    const send = window.ade.agentChat.resumeUsageLimitNow;
    if (typeof send !== "function") {
      return "This ADE runtime can't resume yet. Update the app and try again.";
    }
    const result = await send({ sessionId }, runtimePin);
    // The host refuses a stale or racing press (`no_live_usage_limit`,
    // `resume_in_flight`) and sends nothing. Its `message` is written to be
    // rendered as-is, so show it rather than inventing a second vocabulary for
    // the same two facts. `turnId` is deliberately unread: the transcript is
    // the receipt for a resume, not this popover.
    return result.ok ? null : result.message;
  });

  const setAutoContinue = (next: boolean) => run(async () => {
    await window.ade.agentChat.updateSession(
      { sessionId, autoContinueAtUsageLimit: next },
      runtimePin,
    );
    return null;
  });

  // Same action id and the same event the quota card's Fork button dispatches,
  // so forking from the pill and forking from the card land on one code path.
  const fork = () => {
    try {
      window.dispatchEvent(new CustomEvent("ade:chat:card-action", {
        detail: { actionId: CLAUDE_SESSION_QUOTA_CARD_ACTION, sessionId },
      }));
    } catch {
      /* no-op: a renderer without CustomEvent has no fork surface to open */
    }
    setOpen(false);
  };

  return (
    <div
      ref={containerRef}
      data-testid="usage-limit-resume-pill-root"
      className={cn("relative flex justify-start", className)}
    >
      <button
        type="button"
        data-testid="usage-limit-resume-pill"
        data-usage-limit-state={resume.state}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={pill.ariaLabel}
        onClick={() => setOpen((value) => !value)}
        className={cn(PILL_CLASS, "h-7")}
      >
        <Clock size={12} weight="regular" aria-hidden className="shrink-0 text-muted-fg/75" />
        <span className="min-w-0 truncate text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/80">
          {pill.segments.map((segment, index) => (
            <React.Fragment key={segment}>
              {index > 0 ? <span aria-hidden className="px-1 text-fg/30">·</span> : null}
              <span
                className={cn(
                  index === 0 ? "font-medium text-fg/85" : "text-fg/55",
                  segment === pill.actionHint && "text-fg/80 underline decoration-white/25 underline-offset-2",
                )}
              >
                {segment}
              </span>
            </React.Fragment>
          ))}
        </span>
      </button>

      {popover ? (
        <div
          role="dialog"
          aria-label={popover.title}
          data-testid="usage-limit-resume-popover"
          /* Absolute + bottom-full: the popover grows upward over the
             transcript, so opening it cannot move the composer by a pixel. */
          className="absolute bottom-full left-0 z-40 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-[var(--chat-radius-card)] border border-white/[0.10] bg-[#17161c]/97 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          <div className="font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] font-semibold text-fg/90">
            {popover.title}
          </div>
          <div className="mt-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-fg/65">
            {popover.body}
          </div>
          <div className="mt-0.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-fg/45">
            {popover.reassurance}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="usage-limit-resume-primary"
              disabled={busy}
              onClick={() => {
                if (popover.primary.action === "enable") setAutoContinue(true);
                else void resumeNow();
              }}
              className={cn(
                POPOVER_BUTTON_CLASS,
                "border border-white/[0.14] bg-white/[0.09] text-fg/90 hover:bg-white/[0.14] focus-visible:bg-white/[0.14]",
              )}
            >
              {popover.primary.label}
            </button>
            <button
              type="button"
              data-testid="usage-limit-resume-fork"
              disabled={busy}
              onClick={fork}
              className={cn(
                POPOVER_BUTTON_CLASS,
                "border border-white/[0.08] bg-white/[0.03] text-fg/70 hover:bg-white/[0.08] hover:text-fg/85 focus-visible:bg-white/[0.08]",
              )}
            >
              Fork in this lane
            </button>
            {popover.showDontContinue ? (
              <button
                type="button"
                data-testid="usage-limit-resume-opt-out"
                disabled={busy}
                onClick={() => setAutoContinue(false)}
                className={cn(POPOVER_BUTTON_CLASS, "text-fg/50 hover:bg-white/[0.06] hover:text-fg/75")}
              >
                Don&apos;t continue
              </button>
            ) : null}
          </div>

          {popover.providerDetail ? <ProviderDetail detail={popover.providerDetail} /> : null}

          {actionError ? (
            <div
              role="alert"
              className="mt-2 font-sans text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-rose-200/80"
            >
              {actionError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The provider's own sentence, in the HOST's zone and with its own zone label.
 * Verbatim and behind a toggle: it is the raw evidence, not the product's
 * account of it, and reformatting it here would relabel the zone.
 */
function ProviderDetail({ detail }: { detail: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-2 border-t border-white/[0.06] pt-2">
      <button
        type="button"
        data-testid="usage-limit-resume-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45 transition-colors hover:text-fg/70"
      >
        {open ? "Hide details" : "Details"}
      </button>
      {open ? (
        <div
          data-testid="usage-limit-resume-details"
          className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/60"
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}
