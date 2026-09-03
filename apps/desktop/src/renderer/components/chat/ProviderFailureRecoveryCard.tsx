import React, { useState } from "react";
import type { AgentChatEvent } from "../../../shared/types";
import { formatUsageLimitResetLabel, isUsageLimitChatError } from "../../../shared/chatAutoResume";

export type ProviderFailureRecovery = {
  kind: "capacity" | "rate_limit";
  label: string;
  guidance: string;
};

/**
 * Pending auto-resume for the chat that owns this transcript, published by the
 * chat host. Consumed here rather than drilled through the event-row props so
 * only this card re-renders when the schedule appears or is cancelled.
 */
export type ChatAutoResumeState = {
  /** ADE scheduled-work id, or null when the SDK is waiting natively. */
  scheduleId: string | null;
  /** ISO fire time of the durable scheduled-work row or SDK parked-until instant. */
  nextRunAt: string | null;
  /**
   * {@link providerFailureEventId} of the newest usage-limit failure in this
   * chat. The context is per-chat, so without an anchor every usage-limit card
   * ever written to the transcript would advertise the one armed schedule —
   * including failures from days ago that have nothing to do with it.
   */
  anchorEventId: string | null;
  cancel: () => Promise<string | null> | void;
} | null;

export const ChatAutoResumeContext = React.createContext<ChatAutoResumeState>(null);

/**
 * Identity of one error row, built from the row's own envelope so the chat pane
 * and the transcript row agree without either one knowing the other's indexing.
 *
 * Error events carry no id. The transcript collapse dedupes them by turn plus
 * message, but `turnId` is optional on this path, and a usage limit produces
 * the same message every time it is hit — so turn plus message alone would let
 * a failure from days ago alias the newest one. The envelope timestamp is what
 * separates them.
 */
export function providerFailureEventId(
  timestamp: string,
  event: Extract<AgentChatEvent, { type: "error" }>,
): string {
  return `${timestamp}::${event.turnId ?? ""}::${event.message}`;
}

export function classifyProviderFailure(
  event: Extract<AgentChatEvent, { type: "error" }>,
): ProviderFailureRecovery | null {
  const identity = `${
    typeof event.errorInfo === "string" ? event.errorInfo : event.errorInfo?.category ?? ""
  } ${event.message}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (identity.includes("serveroverloaded") || identity.includes("modelisatcapacity")) {
    return {
      kind: "capacity",
      label: "Provider capacity",
      guidance: "The provider ended this turn because the selected model is at capacity. This thread is still safe to continue.",
    };
  }
  // Delegated rather than spelled out again: the host arms the auto-resume off
  // `isUsageLimitChatError`, and a card that recognised a narrower set of
  // shapes than the schedule did left Codex usage limits ("usageLimitReached")
  // armed on the host with no card, no anchor, and no way to cancel.
  if (isUsageLimitChatError(event)) {
    return {
      kind: "rate_limit",
      label: "Usage limit",
      guidance: "The provider ended this turn at a usage limit. Retry after the limit resets or choose another available model.",
    };
  }
  return null;
}

export function ProviderFailureRecoveryCard({
  recovery,
  eventId,
  disabled,
  onRetry,
  onChooseModel,
}: {
  recovery: ProviderFailureRecovery;
  /** {@link providerFailureEventId} of the error this card belongs to. */
  eventId: string;
  disabled: boolean;
  onRetry?: () => Promise<string | null>;
  onChooseModel?: () => void;
}) {
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const autoResume = React.useContext(ChatAutoResumeContext);
  const autoResumeAt = autoResume?.nextRunAt ? Date.parse(autoResume.nextRunAt) : Number.NaN;
  const showAutoResume = recovery.kind === "rate_limit"
    && autoResume != null
    && autoResume.anchorEventId === eventId
    && Number.isFinite(autoResumeAt);

  const retry = async () => {
    if (!onRetry || retryPending) return;
    setRetryPending(true);
    setRetryError(null);
    try {
      setRetryError(await onRetry());
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryPending(false);
    }
  };

  const cancelAutoResume = async () => {
    if (!autoResume || cancelPending) return;
    setCancelPending(true);
    setRetryError(null);
    try {
      setRetryError((await autoResume.cancel()) ?? null);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelPending(false);
    }
  };

  return (
    <div className="mt-3 rounded-[calc(var(--chat-radius-card)-8px)] border border-amber-300/12 bg-amber-400/[0.045] px-3 py-2.5">
      <div className="text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/72">
        {recovery.guidance}
      </div>
      {showAutoResume ? (
        <div
          data-testid="auto-resume-scheduled"
          className="mt-2 space-y-2 text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/72"
        >
          <div className="font-medium text-amber-50/90">Usage limit reached</div>
          <div>{formatUsageLimitResetLabel(autoResumeAt)}</div>
          <div>Continue automatically</div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={cancelPending}
              className="rounded-md border border-amber-200/16 bg-amber-300/[0.07] px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-amber-50/80 transition-colors hover:border-amber-200/30 hover:bg-amber-300/[0.13] disabled:pointer-events-none disabled:opacity-40"
              onClick={() => { void cancelAutoResume(); }}
            >
              Don&apos;t continue
            </button>
          </div>
        </div>
      ) : (
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={disabled || retryPending || !onRetry}
          className="rounded-md border border-amber-200/16 bg-amber-300/[0.07] px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-amber-50/80 transition-colors hover:border-amber-200/30 hover:bg-amber-300/[0.13] disabled:pointer-events-none disabled:opacity-40"
          onClick={() => { void retry(); }}
        >
          Retry turn
        </button>
        <button
          type="button"
          disabled={disabled || retryPending || !onChooseModel}
          className="rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-fg/65 transition-colors hover:border-violet-300/22 hover:bg-violet-400/[0.08] hover:text-fg/85 disabled:pointer-events-none disabled:opacity-40"
          onClick={() => {
            setRetryError(null);
            onChooseModel?.();
          }}
        >
          Choose model
        </button>
      </div>
      )}
      {retryError ? (
        <div role="alert" className="mt-2 text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-red-200/75">
          {retryError}
        </div>
      ) : null}
    </div>
  );
}
