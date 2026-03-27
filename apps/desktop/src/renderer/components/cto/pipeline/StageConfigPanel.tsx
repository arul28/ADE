import React, { useCallback } from "react";
import type { LinearWorkflowDefinition, LinearWorkflowTrigger } from "../../../../shared/types/linearSync";
import type { LinearWorkflowVisualPlan } from "../../../../shared/linearWorkflowPresets";
import type { PipelineSelection } from "./PipelineVisualization";
import type { PipelineStage } from "./pipelineHelpers";
import { cardCls } from "../shared/designTokens";
import { cn } from "../../ui/cn";
import { TriggerConfig } from "./config/TriggerConfig";
import { ExecutionConfig } from "./config/ExecutionConfig";
import { PlanConfig } from "./config/PlanConfig";
import { CloseoutConfig } from "./config/CloseoutConfig";
import { AdvancedConfig } from "./config/AdvancedConfig";

type Props = {
  workflow: LinearWorkflowDefinition;
  selection: PipelineSelection;
  stages: PipelineStage[];
  visualPlan: LinearWorkflowVisualPlan | null;
  onUpdateWorkflow: (updater: (w: LinearWorkflowDefinition) => LinearWorkflowDefinition) => void;
  onUpdateStage: (index: number, partial: Partial<PipelineStage>) => void;
  onPatchVisualPlan: (patch: Partial<LinearWorkflowVisualPlan>) => void;
  agents: Array<{ value: string; label: string }>;
};

export function StageConfigPanel({
  workflow,
  selection,
  stages,
  visualPlan,
  onUpdateWorkflow,
  onUpdateStage,
  onPatchVisualPlan,
  agents,
}: Props) {
  const handleTriggerUpdate = useCallback(
    (field: keyof LinearWorkflowTrigger, values: unknown) => {
      onUpdateWorkflow((w) => ({
        ...w,
        triggers: { ...w.triggers, [field]: values },
      }));
    },
    [onUpdateWorkflow],
  );

  const handleCloseoutUpdate = useCallback(
    (partial: Partial<NonNullable<LinearWorkflowDefinition["closeout"]>>) => {
      onUpdateWorkflow((w) => ({
        ...w,
        closeout: { ...(w.closeout ?? {}), ...partial },
      }));
    },
    [onUpdateWorkflow],
  );

  if (!selection) return null;

  /* ── Trigger panel ── */
  if (selection.kind === "trigger") {
    return (
      <div className={cn(cardCls, "space-y-1")}>
        <TriggerConfig
          triggers={workflow.triggers}
          onUpdate={handleTriggerUpdate}
        />
      </div>
    );
  }

  /* ── Stage panel ── */
  if (selection.kind === "stage") {
    const stage = stages[selection.index];
    if (!stage) return null;

    return (
      <div className="space-y-4">
        <div className={cn(cardCls, "space-y-1")}>
          <ExecutionConfig
            stage={stage}
            agents={agents}
            onUpdate={(partial) => onUpdateStage(selection.index, partial)}
          />
        </div>

        {/* Show plan config for the first stage when visual plan is available */}
        {selection.index === 0 && visualPlan && (
          <div className={cn(cardCls, "space-y-1")}>
            <PlanConfig
              visualPlan={visualPlan}
              onPatchPlan={onPatchVisualPlan}
              agents={agents}
            />
          </div>
        )}

        <div className={cn(cardCls, "space-y-1")}>
          <AdvancedConfig
            retry={workflow.retry}
            concurrency={workflow.concurrency}
            routing={workflow.routing}
            observability={workflow.observability}
            onUpdateRetry={(patch) =>
              onUpdateWorkflow((w) => ({ ...w, retry: { ...(w.retry ?? {}), ...patch } }))
            }
            onUpdateConcurrency={(patch) =>
              onUpdateWorkflow((w) => ({ ...w, concurrency: { ...(w.concurrency ?? {}), ...patch } }))
            }
            onUpdateRouting={(patch) =>
              onUpdateWorkflow((w) => ({ ...w, routing: { ...(w.routing ?? {}), ...patch } }))
            }
            onUpdateObservability={(patch) =>
              onUpdateWorkflow((w) => ({ ...w, observability: { ...(w.observability ?? {}), ...patch } }))
            }
          />
        </div>
      </div>
    );
  }

  /* ── Closeout panel ── */
  if (selection.kind === "closeout") {
    return (
      <div className={cn(cardCls, "space-y-1")}>
        <CloseoutConfig
          closeout={workflow.closeout ?? {}}
          onUpdate={handleCloseoutUpdate}
        />
      </div>
    );
  }

  return null;
}
