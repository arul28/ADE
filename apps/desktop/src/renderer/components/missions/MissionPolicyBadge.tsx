import React from "react";
import type { MissionExecutionPolicy } from "../../../shared/types";
import { cn } from "../ui/cn";

type MissionPolicyBadgeProps = {
  policy?: MissionExecutionPolicy | null;
  className?: string;
};

function detectPresetLabel(policy: MissionExecutionPolicy): { label: string; color: string } {
  if (
    policy.planning.mode === "off" &&
    policy.testing.mode === "none" &&
    policy.validation.mode === "off" &&
    policy.codeReview.mode === "off" &&
    policy.merge.mode === "off"
  ) return { label: "Quick", color: "bg-sky-500/20 text-sky-300 border-sky-500/30" };

  if (
    policy.planning.mode === "manual_review" &&
    policy.validation.mode === "required" &&
    policy.codeReview.mode === "required"
  ) return { label: "Thorough", color: "bg-orange-500/20 text-orange-300 border-orange-500/30" };

  if (
    policy.planning.mode === "auto" &&
    policy.testing.mode === "post_implementation"
  ) return { label: "Standard", color: "bg-violet-500/20 text-violet-300 border-violet-500/30" };

  return { label: "Custom", color: "bg-muted/30 text-muted-fg border-border/30" };
}

function PhaseIcon({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        "text-[8px] font-bold uppercase leading-none",
        active ? "text-fg/60" : "text-fg/20"
      )}
      title={label}
    >
      {label.charAt(0)}
    </span>
  );
}

export function MissionPolicyBadge({ policy, className }: MissionPolicyBadgeProps) {
  if (policy) {
    const preset = detectPresetLabel(policy);
    return (
      <div className={cn("inline-flex items-center gap-1", className)}>
        <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-medium border", preset.color)}>
          {preset.label}
        </span>
        <span className="inline-flex items-center gap-px">
          <PhaseIcon active={policy.testing.mode !== "none"} label="T" />
          <PhaseIcon active={policy.codeReview.mode !== "off"} label="R" />
          <PhaseIcon active={policy.merge.mode !== "off"} label="M" />
        </span>
        {policy.implementation.model && (
          <span className="text-[8px] font-bold text-fg/40 uppercase">
            {policy.implementation.model === "claude" ? "C" : "X"}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-medium border border-border/30 bg-muted/30 text-muted-fg", className)}>
      Classic
    </span>
  );
}
