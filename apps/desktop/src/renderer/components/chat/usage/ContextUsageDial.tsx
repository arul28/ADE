import { useMemo } from "react";
import {
  HIDDEN_CONTEXT_COMPACT,
  resolveContextCompactControl,
  type ContextCompactControl,
} from "../../../../shared/contextCompaction";
import { SmartTooltip, type SmartTooltipContent } from "../../ui/SmartTooltip";
import { cn } from "../../ui/cn";
import { formatContextTokens, type ContextUsageViewModel } from "./contextUsageModel";

/**
 * Circular context-window dial for the composer footer. The ring fills as the
 * model's context window fills and the integer percentage sits inside it; on
 * hover it shows a rich breakdown via SmartTooltip (`forceEnabled`, so it shows
 * regardless of the user's global "detailed hover tooltips" setting). Replaces
 * the old Codex-only token strip and renders for every provider whose usage
 * view-model is non-null. Returns null when there is nothing to show.
 *
 * Claude, Codex, and Pi can compact from this control. The click sends the
 * existing `/compact` slash (the pane owns that send so an unsent draft is
 * not replaced). Other providers keep a read-only meter.
 */

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 50.27

const COMPACT_STAYS_VISIBLE = "Your visible chat stays; the model gets a summary.";

function ratioColor(ratio: number): string {
  if (ratio >= 0.9) return "#fb7185"; // rose-400 — nearing the limit
  // Amber tier aligns with the ≥80% tooltip warning so the color shift is
  // visible without opening the tooltip.
  if (Math.round(ratio * 100) >= 80) return "#fbbf24"; // amber-400 — context may soon be trimmed/compacted
  return "#38bdf8"; // sky-400
}

function contextStateDescription(state: ContextUsageViewModel["state"]): string | null {
  switch (state) {
    case "compacting":
      return "Claude is compacting this chat. The last exact reading is temporarily hidden.";
    case "recalculating":
      return "Compaction finished. ADE is waiting for the next authoritative usage snapshot.";
    case "unknown":
      return "The runtime did not return an authoritative context reading.";
    case "measured":
      return null;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function compactAriaSuffix(compact: ContextCompactControl): string {
  switch (compact.status) {
    case "hidden":
      return "";
    case "disabled":
      return `. ${compact.reason}`;
    case "ready":
      return ". Compact context";
    default: {
      const exhaustive: never = compact;
      return exhaustive;
    }
  }
}

function contextUsageAriaLabel(
  usage: ContextUsageViewModel,
  percent: number | null,
  compact: ContextCompactControl,
): string {
  const compactSuffix = compactAriaSuffix(compact);
  switch (usage.state) {
    case "compacting":
      return "Context usage: compacting";
    case "recalculating":
      return "Context usage: recalculating";
    case "unknown":
      return "Context usage unavailable";
    case "measured":
      return percent != null
        ? `Context usage: ${percent}% full${compactSuffix}`
        : `Context usage${compactSuffix}`;
    default: {
      const exhaustive: never = usage.state;
      return exhaustive;
    }
  }
}

export function buildContent(
  usage: ContextUsageViewModel,
  modelLabel?: string,
  compact: ContextCompactControl = HIDDEN_CONTEXT_COMPACT,
): SmartTooltipContent {
  const percent = usage.ratio != null ? Math.round(usage.ratio * 100) : null;
  const windowLabel = formatContextTokens(usage.contextWindow);
  const usedLabel = formatContextTokens(usage.usedTokens);
  const estimated = usage.windowSource === "registry";

  const stateDescription = contextStateDescription(usage.state);
  let description = stateDescription
    ?? (percent != null && windowLabel
      ? `Using ${percent}% of ${modelLabel ? `${modelLabel}'s ` : "the "}${windowLabel}-token context window${estimated ? " (estimated)" : ""}.`
      : `${usedLabel ?? "—"} tokens used so far${modelLabel ? ` by ${modelLabel}` : ""} — context window unknown.`);
  if (compact.status === "ready") {
    description = `${description} Click to compact. ${COMPACT_STAYS_VISIBLE}`;
  }

  // Per-turn breakdown line (mono), including the cached + reasoning tokens the
  // old strip dropped. Each segment is omitted when its value is null.
  const segments: string[] = [];
  const inLabel = formatContextTokens(usage.inputTokens);
  const outLabel = formatContextTokens(usage.outputTokens);
  const cacheLabel = formatContextTokens(usage.cacheReadTokens);
  const cacheWriteLabel = formatContextTokens(usage.cacheWriteTokens);
  const reasoningLabel = formatContextTokens(usage.reasoningTokens);
  if (inLabel) segments.push(`in ${inLabel}`);
  if (outLabel) segments.push(`out ${outLabel}`);
  if (cacheLabel) segments.push(`cached ${cacheLabel} ✶`);
  if (usage.cacheWriteTokens != null && usage.cacheWriteTokens > 0 && cacheWriteLabel) {
    segments.push(`cache write ${cacheWriteLabel}`);
  }
  if (reasoningLabel) segments.push(`reasoning ${reasoningLabel}`);

  const content: SmartTooltipContent = {
    label: compact.status === "hidden" ? "Context usage" : "Compact context",
    description,
  };
  if (usage.state === "measured" && percent != null && windowLabel) {
    content.effect = `${usedLabel ?? "—"} / ${windowLabel} tokens · ${percent}% full`;
  }
  if (segments.length > 0) {
    content.gitCommand = segments.join(" · ");
  }
  if (compact.status === "disabled") {
    content.warning = compact.reason;
  } else if (usage.state === "measured" && percent != null && percent >= 80) {
    content.warning = compact.status === "ready"
      ? `Nearing the limit — click to compact. ${COMPACT_STAYS_VISIBLE}`
      : "Nearing the limit — older context may be auto-trimmed or compacted.";
  }
  return content;
}

export function ContextUsageDial({
  usage,
  active,
  compactionPulse,
  modelLabel,
  className,
  compactControl,
  onCompact,
}: {
  usage: ContextUsageViewModel;
  active?: boolean;
  compactionPulse?: boolean;
  modelLabel?: string;
  className?: string;
  compactControl?: ContextCompactControl;
  onCompact?: () => void;
}) {
  const compact = compactControl ?? HIDDEN_CONTEXT_COMPACT;
  const content = useMemo(
    () => buildContent(usage, modelLabel, compact),
    [compact, modelLabel, usage],
  );

  const { ratio, usedTokens } = usage;
  if (ratio == null && usedTokens == null) return null;

  const isMeasured = usage.state === "measured";
  const percent = isMeasured && ratio != null ? Math.round(ratio * 100) : null;
  const dashOffset = ratio != null ? RING_CIRCUMFERENCE * (1 - ratio) : RING_CIRCUMFERENCE;
  const color = ratio != null ? ratioColor(ratio) : "#52525b";

  const inner =
    !isMeasured ? (
      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/[0.12] text-[9px] font-semibold text-fg/55">
        {usage.state === "unknown" ? "?" : "…"}
      </span>
    ) : ratio != null ? (
      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90" aria-hidden>
          <circle cx="10" cy="10" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-white/[0.09]" />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            style={{ transition: "stroke-dashoffset 320ms ease, stroke 320ms ease" }}
            className={active || compactionPulse ? "motion-safe:animate-pulse" : undefined}
          />
        </svg>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center font-semibold leading-none tabular-nums text-fg/75",
            (percent ?? 0) >= 100 ? "text-[7px]" : "text-[8px]",
          )}
        >
          {percent}
        </span>
      </span>
    ) : (
      <span className="inline-flex h-5 shrink-0 items-center text-[10px] tabular-nums text-fg/55">
        {formatContextTokens(usedTokens)}
      </span>
    );

  const ariaLabel = contextUsageAriaLabel(usage, percent, compact);
  const showAction = compact.status !== "hidden";
  const compactDisabled = compact.status !== "ready";
  const triggerClassName = cn(
    "pointer-events-auto inline-flex shrink-0 items-center",
    showAction
      ? cn(
          "h-7 w-7 justify-center rounded-lg transition-colors",
          compactDisabled ? "cursor-default" : "cursor-pointer hover:bg-violet-500/[0.06]",
        )
      : "cursor-default",
    className,
  );

  return (
    <SmartTooltip forceEnabled side="top" content={content}>
      {showAction ? (
        <button
          type="button"
          className={triggerClassName}
          aria-label={ariaLabel}
          disabled={compactDisabled}
          onClick={() => {
            if (compact.status !== "ready") return;
            onCompact?.();
          }}
        >
          {inner}
        </button>
      ) : (
        <span className={triggerClassName} aria-label={ariaLabel}>
          {inner}
        </span>
      )}
    </SmartTooltip>
  );
}

export { resolveContextCompactControl };
export default ContextUsageDial;
