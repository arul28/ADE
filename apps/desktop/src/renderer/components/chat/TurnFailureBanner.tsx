import { useState } from "react";
import type { AgentChatEvent } from "../../../shared/types";
import type { ChatErrorPresentation } from "../../../shared/chatErrorPresentation";
import { isUsageLimitChatError } from "../../../shared/chatAutoResume";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Banner, noticeTone, type NoticeAction } from "../ui/notice";
import { ProviderLogo } from "../shared/ProviderLogos";

export type ProviderFailureRecovery = {
  kind: "capacity" | "rate_limit";
  title: string;
};

export function classifyProviderFailure(
  event: Extract<AgentChatEvent, { type: "error" }>,
): ProviderFailureRecovery | null {
  const identity = `${
    typeof event.errorInfo === "string" ? event.errorInfo : event.errorInfo?.category ?? ""
  } ${event.message}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (identity.includes("serveroverloaded") || identity.includes("modelisatcapacity")) {
    return { kind: "capacity", title: "Model at capacity" };
  }
  // Delegated rather than spelled out again: the host computes
  // `usageLimitResume` off `isUsageLimitChatError`, and a card that recognised
  // a narrower set of shapes than the host did left usage limits labelled as a
  // generic stop.
  if (isUsageLimitChatError(event)) {
    return { kind: "rate_limit", title: "Usage limit reached" };
  }
  return null;
}

// Only providers with a real mark: anything else keeps the tone glyph rather
// than an initial in a circle.
const PROVIDER_MARKS = new Set([
  "claude", "codex", "cursor", "opencode", "droid", "factory", "pi", "devin", "copilot", "github-copilot", "gemini",
]);

function providerMark(provider: string | null | undefined) {
  const family = provider?.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return PROVIDER_MARKS.has(family) ? <ProviderLogo family={family} size={14} /> : undefined;
}

/**
 * A failed turn in the transcript: one inline banner. The title says what
 * happened, the detail is the one sentence that explains it, and the buttons
 * are the ways forward. A usage limit or a model at capacity leads with
 * Choose model, because retrying the same model fails again; anything else
 * leads with Retry. Raw provider text stays behind Details.
 *
 * Auto-resume is deliberately absent: when a usage limit is live, the pill
 * above the composer (`ChatUsageLimitResumePill`) owns that decision.
 */
export function TurnFailureBanner({
  id,
  presentation,
  recovery,
  provider,
  disabled,
  onRetry,
  onChooseModel,
}: {
  id: string;
  presentation: ChatErrorPresentation;
  recovery: ProviderFailureRecovery | null;
  provider?: string | null;
  disabled: boolean;
  /** Resolves to an error message when the retry could not start. */
  onRetry?: () => Promise<string | null>;
  onChooseModel?: () => void;
}) {
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { copy, copied } = useCopyToClipboard();
  const technical = presentation.technicalDetail?.trim() ?? "";

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

  const retryAction: NoticeAction | null = onRetry
    ? { label: "Retry turn", onClick: () => { void retry(); }, busy: retryPending, disabled }
    : null;
  const chooseModelAction: NoticeAction | null = onChooseModel
    ? { label: "Choose model", onClick: () => { setRetryError(null); onChooseModel(); }, disabled: disabled || retryPending }
    : null;
  const ordered = recovery ? [chooseModelAction, retryAction] : [retryAction, chooseModelAction];
  const actions: NoticeAction[] = [];
  ordered.forEach((action) => {
    if (action) actions.push({ ...action, variant: actions.length === 0 ? "primary" : "secondary" });
  });
  if (technical) {
    actions.push({ label: "Details", variant: "link", expanded: detailsOpen, onClick: () => setDetailsOpen((open) => !open) });
  }

  return (
    <Banner
      layout="inline"
      model={{
        id,
        tone: "warning",
        icon: providerMark(provider),
        title: recovery?.title ?? presentation.title,
        detail: presentation.body,
        actions,
        ...(retryError || (technical && detailsOpen)
          ? {
              extra: (
                <div className="flex flex-col gap-1.5">
                  {retryError ? (
                    <span role="alert" className="text-[11.5px] font-medium leading-snug" style={{ color: noticeTone("error").text }}>
                      {retryError}
                    </span>
                  ) : null}
                  {technical && detailsOpen ? (
                    <div className="flex items-start gap-2">
                      <pre className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(color:--kit-text-2)">
                        {technical}
                      </pre>
                      <button
                        type="button"
                        className="kit-btn kit-btn-ghost shrink-0"
                        data-size="sm"
                        onClick={() => void copy(technical)}
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ),
            }
          : {}),
      }}
    />
  );
}
