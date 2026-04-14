import React from "react";
import { Funnel } from "@phosphor-icons/react";
import type { LinearWorkflowTrigger } from "../../../../shared/types/linearSync";
import { cn } from "../../ui/cn";

type Props = {
  triggers: LinearWorkflowTrigger;
  selected: boolean;
  onSelect: () => void;
};

/** Build a human-readable sentence describing the trigger conditions. */
function buildTriggerSentence(triggers: LinearWorkflowTrigger): React.ReactNode[] {
  const parts: React.ReactNode[] = [];

  const assignees = triggers.assignees ?? [];
  const labels = triggers.labels ?? [];
  const projects = triggers.projectSlugs ?? [];
  const teams = triggers.teamKeys ?? [];
  const priorities = triggers.priority ?? [];
  const stateChanges = triggers.stateTransitions ?? [];

  if (assignees.length > 0) {
    parts.push(
      <span key="assignees">
        Assigned to{" "}
        {assignees.map((name, i) => (
          <React.Fragment key={name}>
            {i > 0 && <span className="text-muted-fg/50"> or </span>}
            <strong className="font-semibold text-[#A78BFA]">{name}</strong>
          </React.Fragment>
        ))}
      </span>,
    );
  }

  if (labels.length > 0) {
    parts.push(
      <span key="labels">
        labeled{" "}
        {labels.map((name, i) => (
          <React.Fragment key={name}>
            {i > 0 && <span className="text-muted-fg/50"> or </span>}
            <strong className="font-semibold text-[#34D399]">{name}</strong>
          </React.Fragment>
        ))}
      </span>,
    );
  }

  if (projects.length > 0) {
    parts.push(
      <span key="projects">
        in project{projects.length > 1 ? "s" : ""}{" "}
        {projects.map((slug, i) => (
          <React.Fragment key={slug}>
            {i > 0 && <span className="text-muted-fg/50">, </span>}
            <strong className="font-semibold text-[#A78BFA]">{slug}</strong>
          </React.Fragment>
        ))}
      </span>,
    );
  }

  if (teams.length > 0) {
    parts.push(
      <span key="teams">
        in team{teams.length > 1 ? "s" : ""}{" "}
        {teams.map((key, i) => (
          <React.Fragment key={key}>
            {i > 0 && <span className="text-muted-fg/50">, </span>}
            <strong className="font-semibold text-[#FBBF24]">{key}</strong>
          </React.Fragment>
        ))}
      </span>,
    );
  }

  if (priorities.length > 0) {
    parts.push(
      <span key="priority">
        priority{" "}
        <strong className="font-semibold text-[#FB7185]">{priorities.join(", ")}</strong>
      </span>,
    );
  }

  if (stateChanges.length > 0) {
    parts.push(
      <span key="states">
        on{" "}
        <strong className="font-semibold text-[#F472B6]">
          {stateChanges.length} state change{stateChanges.length > 1 ? "s" : ""}
        </strong>
      </span>,
    );
  }

  return parts;
}

export function TriggerCard({ triggers, selected, onSelect }: Props) {
  const parts = buildTriggerSentence(triggers);
  const hasTriggers = parts.length > 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex flex-col items-start rounded-xl px-4 py-3 text-left transition-all duration-200",
        "min-w-[170px] max-w-[220px]",
        selected ? "ring-1 ring-[#A78BFA]" : "hover:bg-white/[0.03]",
      )}
      style={{
        background: selected ? "rgba(167,139,250,0.05)" : "rgba(19,24,34,0.7)",
        border: `1px solid ${selected ? "rgba(167,139,250,0.25)" : "rgba(255,255,255,0.06)"}`,
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-center gap-2">
        <Funnel size={14} style={{ color: "#A78BFA" }} weight="duotone" />
        <span className="text-[13px] font-medium text-fg">When</span>
      </div>

      {hasTriggers ? (
        <div className="mt-2 text-[11px] leading-[1.5] text-muted-fg/60">
          {parts.map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 && (
                <span className="text-muted-fg/35">
                  {/* First group uses AND, nested conditions use commas */}
                  {i === 1 ? " AND " : ", "}
                </span>
              )}
              {part}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-muted-fg/30">No triggers set</div>
      )}
    </button>
  );
}
