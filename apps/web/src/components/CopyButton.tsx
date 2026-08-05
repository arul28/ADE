import { useCallback, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";
import { ANALYTICS_FEATURE_ATTRIBUTE, type MarketingFeature } from "../lib/marketingAnalytics";

/**
 * `app` matches the product chrome (rounded cards, muted borders).
 * `editorial` matches the magazine surfaces — cream on ink, 2px corners,
 * hairline borders — used inside the install dialog.
 */
type CopyButtonVariant = "app" | "editorial";

export function CopyButton({
  value,
  className,
  compact = false,
  variant = "app",
  analyticsFeature,
  label,
}: {
  value: string;
  className?: string;
  compact?: boolean;
  variant?: CopyButtonVariant;
  analyticsFeature?: MarketingFeature;
  /** Accessible name; defaults to a generic "Copy to clipboard". */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const canCopy = useMemo(() => typeof navigator !== "undefined" && !!navigator.clipboard, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // No-op: if clipboard is blocked, we still keep the UI stable.
      setCopied(false);
    }
  }, [value]);

  return (
    <button
      type="button"
      className={cn(
        "focus-ring inline-flex items-center gap-2 transition-all disabled:opacity-60",
        "duration-200 [transition-timing-function:var(--ease-out)]",
        compact && "gap-0",
        variant === "app" &&
          "h-9 rounded-lg border border-border bg-card/70 px-3 text-sm text-fg hover:bg-card hover:shadow-glass-sm",
        variant === "editorial" &&
          cn(
            "h-8 shrink-0 rounded-[2px] border border-[color:var(--color-hairline-strong)] px-2.5",
            "text-[12px] font-medium text-[color:var(--color-cream-muted)]",
            "hover:border-[color:var(--color-cream)] hover:bg-white/[0.06] hover:text-[color:var(--color-cream)]",
          ),
        className,
      )}
      onClick={onCopy}
      disabled={!canCopy}
      aria-label={copied ? "Copied" : (label ?? "Copy to clipboard")}
      {...(analyticsFeature ? { [ANALYTICS_FEATURE_ATTRIBUTE]: analyticsFeature } : {})}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {!compact && (copied ? "Copied" : "Copy")}
    </button>
  );
}
