import React, { useEffect, useMemo, useState } from "react";
import type { CtoIdentity, CtoSystemPromptPreview } from "../../../shared/types";
import { cn } from "../ui/cn";
import { cardCls, recessedPanelCls } from "./shared/designTokens";

export function CtoPromptPreview({
  identityOverride,
  title = "Effective CTO prompt",
  subtitle = "ADE owns the doctrine. Personality is layered on top. Project continuity comes from memory and current context, not from this immutable prompt.",
  compact = false,
}: {
  identityOverride?: Partial<CtoIdentity>;
  title?: string;
  subtitle?: string;
  compact?: boolean;
}) {
  const [preview, setPreview] = useState<CtoSystemPromptPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const overrideKey = useMemo(() => JSON.stringify(identityOverride ?? {}), [identityOverride]);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.ade?.cto;
    if (!bridge) {
      setLoading(false);
      setError("CTO bridge is not available.");
      setPreview(null);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    void bridge.previewSystemPrompt({ identityOverride })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load prompt preview.");
        setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- overrideKey serializes identityOverride for stable comparison
  }, [overrideKey]);

  return (
    <div className={cn(cardCls, compact ? "space-y-3 p-4" : "space-y-4 p-4")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-fg/40">{title}</div>
          <div className="mt-2 text-xs leading-5 text-muted-fg/45">{subtitle}</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[10px] text-fg/62">
          {loading ? "Loading..." : `${preview?.tokenEstimate ?? 0} est. tokens`}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}

      <div className="space-y-3">
        {(preview?.sections ?? []).map((section) => (
          <div key={section.id} className={cn(recessedPanelCls, "space-y-2 p-3")}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-fg/45">{section.title}</div>
            <div className="whitespace-pre-wrap text-[11px] leading-6 text-fg/68">{section.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
