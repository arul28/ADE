import type { PhaseCard } from "../../../shared/types";
import { cn } from "../ui/cn";

type MissionPhaseBadgeProps = {
  phases?: PhaseCard[] | null;
  profileName?: string | null;
  className?: string;
};

function PhaseIcon({ active, label, tooltip }: { active: boolean; label: string; tooltip?: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-sans)",
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

export function MissionPhaseBadge({ phases, profileName, className }: MissionPhaseBadgeProps) {
  if (!phases?.length) {
    return (
      <span
        className={cn(className)}
        style={{
          background: "#1E1B26",
          color: "#71717A",
          border: "1px solid #27272A",
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px",
          padding: "3px 8px",
          borderRadius: 0
        }}
      >
        NO PHASES
      </span>
    );
  }

  const phaseKeys = new Set(phases.map((p) => p.phaseKey));

  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      {profileName && (
        <span
          style={{
            background: "#A78BFA18",
            color: "#A78BFA",
            border: "1px solid #A78BFA30",
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "1px",
            padding: "3px 8px",
            borderRadius: 0
          }}
        >
          {profileName}
        </span>
      )}
      <span className="inline-flex items-center gap-px">
        <PhaseIcon active={phaseKeys.has("planning")} label="P" tooltip="Planning" />
        <PhaseIcon active={phaseKeys.has("development") || phaseKeys.has("implementation")} label="D" tooltip="Development" />
        <PhaseIcon active={phaseKeys.has("testing")} label="T" tooltip="Testing" />
        <PhaseIcon active={phaseKeys.has("validation")} label="V" tooltip="Validation" />
        <PhaseIcon active={phaseKeys.has("code_review") || phaseKeys.has("test_review") || phaseKeys.has("review")} label="R" tooltip="Review" />
      </span>
    </div>
  );
}
