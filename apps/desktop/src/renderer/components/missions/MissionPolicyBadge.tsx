import React from "react";
import type { MissionExecutionPolicy } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
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
    policy.codeReview.mode === "off"
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

function PhaseIcon({ active, label, tooltip }: { active: boolean; label: string; tooltip?: string }) {
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
      title={tooltip ?? label}
    >
      {label}
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
          <PhaseIcon active={policy.planning.mode !== "off"} label="P" tooltip={`Planning: ${policy.planning.mode}`} />
          <PhaseIcon active={policy.testing.mode !== "none"} label="T" tooltip={`Testing: ${policy.testing.mode}`} />
          <PhaseIcon active={policy.validation.mode !== "off"} label="V" tooltip={`Validation: ${policy.validation.mode}`} />
          <PhaseIcon active={policy.codeReview.mode !== "off"} label="R" tooltip={`Review: ${policy.codeReview.mode}`} />
          <PhaseIcon active={policy.prStrategy?.kind !== "manual" && policy.prStrategy != null} label="PR" tooltip={`PR strategy: ${policy.prStrategy?.kind ?? "none"}`} />
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
            {(() => {
              const m = policy.implementation.model;
              const desc = m ? getModelById(m) : undefined;
              if (desc) return desc.family === "anthropic" ? "C" : desc.family === "openai" ? "X" : desc.shortId.charAt(0).toUpperCase();
              return m === "claude" ? "C" : m === "codex" ? "X" : (m ?? "?").charAt(0).toUpperCase();
            })()}
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
