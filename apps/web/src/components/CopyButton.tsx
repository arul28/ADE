import { useCallback, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";

export function CopyButton({ value, className }: { value: string; className?: string }) {
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
        "focus-ring inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card/70 px-3 text-sm text-fg transition-all",
        "duration-200 [transition-timing-function:var(--ease-out)] hover:bg-card hover:shadow-glass-sm",
        "disabled:opacity-60",
        className
      )}
      onClick={onCopy}
      disabled={!canCopy}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

