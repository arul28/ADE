import React from "react";
import { ArrowRight } from "@phosphor-icons/react";
import type { LinearWorkflowDefinition } from "../../../../shared/types/linearSync";
import { flattenTargetChain, type PipelineStage } from "./pipelineHelpers";
import { STAGE_COLORS, STEP_TYPE_LABELS, enumLabel } from "./pipelineLabels";
import { StageCard } from "./StageCard";
import { TriggerCard } from "./TriggerCard";
import { CloseoutCard } from "./CloseoutCard";
import { StageConnector } from "./StageConnector";

export type PipelineSelection =
  | { kind: "trigger" }
  | { kind: "stage"; index: number }
  | { kind: "closeout" }
  | null;

type Props = {
  workflow: LinearWorkflowDefinition;
  selection: PipelineSelection;
  onSelect: (sel: PipelineSelection) => void;
  onAddStage: (afterIndex: number) => void;
  onRemoveStage: (index: number) => void;
};

/** Resolve the accent color for a given stage. */
function stageColor(stage: PipelineStage): string {
  return STAGE_COLORS[stage.type] ?? "#A78BFA";
}

const TRIGGER_COLOR = "#A78BFA";
const CLOSEOUT_COLOR = "#34D399";

export function PipelineVisualization({ workflow, selection, onSelect, onAddStage, onRemoveStage }: Props) {
  const stages: PipelineStage[] = flattenTargetChain(workflow.target);
  const canRemoveStages = stages.length > 1;
  const multiStage = stages.length > 1;
  const steps = workflow.steps ?? [];

  // Determine if notifications are enabled in observability
  const notificationsEnabled = workflow.observability?.emitNotifications === true;

  return (
    <div className="flex flex-col gap-4">
      {/* Pipeline cards row */}
      <div className="flex items-stretch gap-0 overflow-x-auto py-4 px-2">
        {/* Trigger node */}
        <TriggerCard
          triggers={workflow.triggers}
          selected={selection?.kind === "trigger"}
          onSelect={() => onSelect({ kind: "trigger" })}
        />

        <StageConnector
          onAddStage={() => onAddStage(0)}
          leftColor={TRIGGER_COLOR}
          rightColor={stages.length > 0 ? stageColor(stages[0]) : CLOSEOUT_COLOR}
          multiStage={multiStage}
        />

        {/* Stage nodes */}
        {stages.map((stage, index) => (
          <React.Fragment key={index}>
            <StageCard
              stage={stage}
              index={index}
              selected={selection?.kind === "stage" && selection.index === index}
              onSelect={() => onSelect({ kind: "stage", index })}
              onRemove={canRemoveStages ? () => onRemoveStage(index) : undefined}
            />
            <StageConnector
              onAddStage={() => onAddStage(index + 1)}
              leftColor={stageColor(stage)}
              rightColor={
                index + 1 < stages.length
                  ? stageColor(stages[index + 1])
                  : CLOSEOUT_COLOR
              }
              multiStage={multiStage}
            />
          </React.Fragment>
        ))}

        {/* Closeout node */}
        <CloseoutCard
          closeout={workflow.closeout}
          selected={selection?.kind === "closeout"}
          onSelect={() => onSelect({ kind: "closeout" })}
          notificationsEnabled={notificationsEnabled}
        />
      </div>

      {/* Step preview below the pipeline */}
      {steps.length > 0 && (
        <div
          className="mx-2 rounded-xl px-4 py-3"
          style={{
            background: "rgba(14,18,26,0.6)",
            border: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
            {steps.map((step, i) => {
              const label = step.name || enumLabel(STEP_TYPE_LABELS, step.type) || step.type;
              return (
                <React.Fragment key={step.id}>
                  {i > 0 && (
                    <ArrowRight
                      size={10}
                      className="text-muted-fg/20 shrink-0"
                    />
                  )}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold shrink-0"
                      style={{
                        background: "rgba(167,139,250,0.10)",
                        color: "rgba(167,139,250,0.70)",
                        border: "1px solid rgba(167,139,250,0.15)",
                      }}
                    >
                      {i + 1}
                    </span>
                    <span className="text-[11px] text-muted-fg/50 whitespace-nowrap">{label}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
