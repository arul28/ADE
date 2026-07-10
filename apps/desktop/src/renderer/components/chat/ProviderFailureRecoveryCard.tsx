import { useState } from "react";
import type { AgentChatEvent } from "../../../shared/types";

export type ProviderFailureRecovery = {
  kind: "capacity" | "rate_limit";
  label: string;
  guidance: string;
};

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
  if (identity.includes("usagelimitexceeded") || identity.includes("ratelimit")) {
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
  disabled,
  onRetry,
  onChooseModel,
}: {
  recovery: ProviderFailureRecovery;
  disabled: boolean;
  onRetry?: () => Promise<string | null>;
  onChooseModel?: () => void;
}) {
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

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

  return (
    <div className="mt-3 rounded-[calc(var(--chat-radius-card)-8px)] border border-amber-300/12 bg-amber-400/[0.045] px-3 py-2.5">
      <div className="text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/72">
        {recovery.guidance}
      </div>
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
      {retryError ? (
        <div role="alert" className="mt-2 text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-red-200/75">
          {retryError}
        </div>
      ) : null}
    </div>
  );
}
