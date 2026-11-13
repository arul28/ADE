import React from "react";
import "./laneShare.css";

/**
 * The two small pieces every lane sharing surface uses instead of tags:
 * a one-line fact line that truncates (never wraps into a strip of pills),
 * and a state as a status dot and a word.
 */

export type LaneShareTone = "ok" | "warn" | "crit" | null | undefined;

/** Facts on one line, separated by a quiet dot. Empty parts are skipped. */
export function LaneShareMeta({ parts, className, testId }: { parts: Array<React.ReactNode | null | false | undefined>; className?: string; testId?: string }) {
  const shown = parts.filter((part): part is React.ReactNode => part != null && part !== false && part !== "");
  if (shown.length === 0) return null;
  return (
    <span className={className ? `ade-ls-meta ${className}` : "ade-ls-meta"} data-testid={testId}>
      {shown.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span className="ade-ls-meta-sep" aria-hidden>·</span> : null}
          <span>{part}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

/** A state as a dot and a word; a neutral state has the kit's muted dot. */
export function LaneShareState({ label, tone, title }: { label: string; tone?: LaneShareTone; title?: string }) {
  return (
    <span className="ade-ls-state" data-tone={tone ?? undefined} title={title}>
      <span className="kit-dot" data-state={tone ?? undefined} aria-hidden />
      {label}
    </span>
  );
}

/** A risk level as a word in its colour, for a fact line. Low risk reads as nothing. */
export function LaneShareRiskWord({ level }: { level: "low" | "medium" | "high" | null | undefined }) {
  if (!level || level === "low") return null;
  return <span className="ade-ls-risk-level" data-tone={level === "high" ? "crit" : "warn"}>{level === "high" ? "High risk" : "Medium risk"}</span>;
}

/** Permission modes in plain words, for every sharing surface. */
export const LANE_SHARE_MODE_TITLES: Record<string, string> = {
  default: "Ask first",
  plan: "Plan mode",
  auto: "Auto",
  edit: "Edit",
  "full-auto": "Full auto",
  "config-toml": "Provider config",
};

/** A permission mode in plain words. */
export function laneShareModeTitle(mode: string): string {
  return LANE_SHARE_MODE_TITLES[mode] ?? mode;
}

/** Reasoning levels in plain words, for every sharing surface. */
export const LANE_SHARE_REASONING_TITLES: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** A reasoning level in plain words. */
export function laneShareReasoningTitle(level: string): string {
  return LANE_SHARE_REASONING_TITLES[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}
