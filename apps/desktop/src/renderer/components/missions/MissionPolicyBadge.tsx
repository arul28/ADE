import React from "react";
import type { MissionExecutionPolicy } from "../../../shared/types";
import { cn } from "../ui/cn";

type MissionPolicyBadgeProps = {
  policy?: MissionExecutionPolicy | null;
  className?: string;
};

function detectPresetLabel(policy: MissionExecutionPolicy): { label: string; style: React.CSSProperties } {
  if (
    policy.planning.mode === "off" &&
    policy.testing.mode === "none" &&
    policy.validation.mode === "off" &&
    policy.codeReview.mode === "off" &&
    policy.merge.mode === "off"
  ) return {
    label: "QUICK",
    style: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" }
  };

  if (
    policy.planning.mode === "manual_review" &&
    policy.validation.mode === "required" &&
    policy.codeReview.mode === "required"
  ) return {
    label: "THOROUGH",
    style: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" }
  };

  if (
    policy.planning.mode === "auto" &&
    policy.testing.mode === "post_implementation"
  ) return {
    label: "STANDARD",
    style: { background: "#A78BFA18", color: "#A78BFA", border: "1px solid #A78BFA30" }
  };

  return {
    label: "CUSTOM",
    style: { background: "#1E1B26", color: "#71717A", border: "1px solid #27272A" }
  };
}

function PhaseIcon({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      style={{
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 8,
        fontWeight: 700,
        textTransform: "uppercase",
        lineHeight: 1,
        color: active ? "#FAFAFA" : "#52525B"
      }}
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
        <span
          style={{
            ...preset.style,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "1px",
            padding: "3px 8px",
            borderRadius: 0
          }}
        >
          {preset.label}
        </span>
        <span className="inline-flex items-center gap-px">
          <PhaseIcon active={policy.testing.mode !== "none"} label="T" />
          <PhaseIcon active={policy.codeReview.mode !== "off"} label="R" />
          <PhaseIcon active={policy.merge.mode !== "off"} label="M" />
        </span>
        {policy.implementation.model && (
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 8,
              fontWeight: 700,
              color: "#52525B",
              textTransform: "uppercase"
            }}
          >
            {policy.implementation.model === "claude" ? "C" : "X"}
          </span>
        )}
      </div>
    );
  }

  return (
    <span
      className={cn("", className)}
      style={{
        background: "#1E1B26",
        color: "#71717A",
        border: "1px solid #27272A",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 9,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "1px",
        padding: "3px 8px",
        borderRadius: 0
      }}
    >
      CLASSIC
    </span>
  );
}
